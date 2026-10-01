// Atelier — Cloudflare Worker
// Serves the PWA (static assets) and proxies a strict allow-list of AI provider endpoints:
// NVIDIA build, Anthropic (via the official SDK), OpenAI and Google Gemini.
// Provider APIs don't allow browser CORS (and keys stay server-side), so every call goes through /api/*.
import { claudeChat } from './anthropic.js';
import { hasVideoPart, geminiNativeChat, handleVideoApi, VIDEO_NEEDS_GEMINI } from './gemini.js';
import { toolList, runTool, GOOGLE_SCOPES, saveGoogleAccount, removeGoogleAccount, addTokenAccount, removeTokenAccount, googleTokenFor,
  CANVA_ID, CANVA_MAX_IMAGE, CanvaError, canvaConfigured, canvaAuthUrl, canvaTakeState, canvaCompleteAuth, removeCanvaAccount, canvaSendImage,
  canvaListDesigns, canvaDesignFormats, canvaImport, canvaFetchFile } from './tools.js';
import { identify, handleLinkedIn, signedOut, fail } from './tester/auth.js';
import { testerRouter, testerAdmin } from './tester/router.js';
import { handleTts } from './tts.js';
export { Relay } from './relay.js';
export { Ledger } from './tester/ledger.js';

const NVIDIA = {
  chat: 'https://integrate.api.nvidia.com/v1',
  genai: 'https://ai.api.nvidia.com/v1/genai',
  nvcf: 'https://api.nvcf.nvidia.com/v2/nvcf',
};

// Models only reachable through an NVCF function id (no ai.api.nvidia.com route).
const FUNCTIONS = {
  'cosmos3-nano': 'd09cd49d-d7f2-4361-928f-ea22af707249',
};

// Provider keys live only in Worker secrets; every call must carry the APP_PASSCODE (x-app-pass).
const PROVIDERS = {
  nvidia: { secret: 'NVIDIA_API_KEY', name: 'NVIDIA' },
  anthropic: { secret: 'ANTHROPIC_API_KEY', name: 'Anthropic' },
  openai: { secret: 'OPENAI_API_KEY', name: 'OpenAI' },
  gemini: { secret: 'GEMINI_API_KEY', name: 'Gemini' },
  zai: { secret: 'ZAI_API_KEY', name: 'Z.ai' },
  deepseek: { secret: 'DEEPSEEK_API_KEY', name: 'DeepSeek' },
  meta: { secret: 'META_API_KEY', name: 'Meta' },
};

// Non-chat pass-through routes: /api/x/<provider>/<path>, only for these method + path shapes.
const PASSTHRU = {
  openai: {
    base: 'https://api.openai.com/v1',
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    // (OpenAI's Videos API was shut down 2026-09-24.)
    allow: [['POST', /^images\/(generations|edits)$/]],
  },
  meta: {
    base: 'https://api.meta.ai/v1',
    auth: (k) => ({ authorization: `Bearer ${k}` }),
    allow: [['POST', /^images\/generations$/]],
  },
  gemini: {
    base: 'https://generativelanguage.googleapis.com',
    auth: (k) => ({ 'x-goog-api-key': k }),
    allow: [
      ['POST', /^v1(beta)?\/models\/[\w.-]+:(generateContent|predictLongRunning)$/],
      ['GET', /^v1beta\/models\/[\w.-]+\/operations\/[\w.-]+$/],
      ['GET', /^v1(beta)?\/files\/[\w.-]+:download$/],
    ],
  },
};

const CHAT_UPSTREAM = {
  nvidia: { url: `${NVIDIA.chat}/chat/completions`, auth: (k) => ({ authorization: `Bearer ${k}` }) },
  openai: { url: 'https://api.openai.com/v1/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  zai: { url: 'https://api.z.ai/api/paas/v4/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
  meta: { url: 'https://api.meta.ai/v1/chat/completions', auth: (k) => ({ authorization: `Bearer ${k}` }) },
};

const PASS_HEADERS = ['content-type', 'content-length', 'nvcf-reqid', 'nvcf-status', 'nvcf-percent-complete', 'retry-after'];
const SEG = /^[A-Za-z0-9._-]+$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// A failed /api/canva/* call → JSON {error} with the CanvaError's status (anything unexpected is a 502).
function canvaFail(err, fallback) {
  if (!(err instanceof CanvaError)) console.error('canva route failed', String(err?.message || err).slice(0, 200));
  const status = err instanceof CanvaError && [400, 401, 403, 404, 429].includes(err.status) ? err.status : 502;
  return json({ error: err instanceof CanvaError ? err.message : fallback }, status);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const passOk = (req, env) => Boolean(env.APP_PASSCODE) && safeEqual(req.headers.get('x-app-pass') || '', env.APP_PASSCODE);

function resolveKey(req, env, provider) {
  const secret = env[PROVIDERS[provider].secret];
  return secret && passOk(req, env) ? secret : null;
}

function missingKey(req, env, provider) {
  if (!passOk(req, env)) return json({ error: req.headers.get('x-app-pass') ? 'Wrong passcode — check it in Settings.' : 'Enter your passcode to use Atelier.' }, 401);
  return json({ error: `No ${PROVIDERS[provider].name} key on the server (set ${PROVIDERS[provider].secret}).` }, 401);
}

async function forward(target, { method, headers, body }) {
  let upstream;
  try {
    upstream = await fetch(target, { method, headers, body, redirect: 'manual' });
    // Large results redirect to a signed URL — fetch it WITHOUT our credentials.
    const loc = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && loc) upstream = await fetch(loc);
  } catch (err) {
    console.error('upstream unreachable', new URL(target).host, err.message);
    return json({ error: `Upstream unreachable: ${err.message}` }, 502);
  }
  const out = new Headers({ 'cache-control': 'no-store' });
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  // Log provider rejections (status + error text only — never request bodies or keys) for debugging.
  if (!upstream.ok) {
    const t = new URL(target);
    const txt = await upstream.text().catch(() => '');
    console.warn('upstream', upstream.status, t.host + t.pathname, txt.slice(0, 400));
    out.delete('content-length');
    return new Response(txt, { status: upstream.status, headers: out });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function providerOf(model = '') {
  const m = model.match(/^(anthropic|openai|gemini|zai|deepseek|meta):/);
  return m ? m[1] : 'nvidia';
}

// Adjust the shared OpenAI-style body for each upstream's quirks.
function shapeChatBody(provider, body) {
  const b = { ...body, model: body.model.replace(/^(openai|gemini|zai|deepseek|meta):/, '') };
  if (provider === 'deepseek') {
    // Thinking is on by default; helper calls turn it off. In thinking mode temperature isn't accepted.
    const off = body.chat_template_kwargs?.enable_thinking === false;
    b.thinking = { type: off ? 'disabled' : 'enabled' };
    if (off) delete b.reasoning_effort;
    else { b.reasoning_effort = { low: 'low', xhigh: 'max', max: 'max' }[body.reasoning_effort] || 'high'; delete b.temperature; }
  }
  if (provider === 'zai') {
    // GLM uses its own thinking switch. GLM-5.x always thinks (it rejects "disabled"), so it gets
    // low/high effort instead; older GLM models can switch thinking off for quick helper calls.
    const off = body.chat_template_kwargs?.enable_thinking === false || body.reasoning_effort === 'low';
    if (/^glm-5/.test(b.model)) {
      b.thinking = { type: 'enabled' };
      b.reasoning_effort = off ? 'low' : { xhigh: 'max', max: 'max' }[body.reasoning_effort] || 'high';
    } else {
      b.thinking = { type: off ? 'disabled' : 'enabled' };
      delete b.reasoning_effort;
    }
  }
  delete b.web_search; // Claude-only (server-side web search tool)
  // Claude-only replay data never goes to other providers.
  b.messages = b.messages.map(({ anthropic_content, ...m }) => m);
  if (provider !== 'nvidia') {
    delete b.chat_template_kwargs;
    delete b.top_p;
    if (provider !== 'deepseek') b.messages = b.messages.map(({ reasoning_content, ...m }) => m);
  } else if (!/kimi/i.test(b.model)) {
    b.messages = b.messages.map(({ reasoning_content, ...m }) => m); // only Kimi wants its reasoning replayed
  }
  if (provider === 'openai' || provider === 'meta') {
    // Reasoning models only accept max_completion_tokens and the default temperature.
    if (b.max_tokens) b.max_completion_tokens = b.max_tokens;
    delete b.max_tokens;
    delete b.temperature;
  }
  if (provider === 'nvidia' || provider === 'meta') delete b.reasoning_effort;
  return b;
}

async function handleChat(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad JSON body' }, 400);
  }
  if (!body?.model || !Array.isArray(body.messages)) return json({ error: 'model and messages are required' }, 400);
  const provider = providerOf(body.model);
  const key = resolveKey(req, env, provider);
  if (!key) return missingKey(req, env, provider);
  // A video_file part (a clip in Gemini's Files API) → Gemini's native streamGenerateContent; no other model can read one.
  // Every other Gemini chat, frames-only included, stays on the OpenAI-compatible route below.
  if (hasVideoPart(body)) return provider === 'gemini' ? geminiNativeChat(body, key) : json({ error: VIDEO_NEEDS_GEMINI }, 400);

  if (provider === 'anthropic') return claudeChat(body, key, env.ANTHROPIC_WORKSPACE_ID);

  const up = CHAT_UPSTREAM[provider];
  return forward(up.url, {
    method: 'POST',
    headers: { ...up.auth(key), 'content-type': 'application/json', accept: req.headers.get('accept') || 'application/json' },
    body: JSON.stringify(shapeChatBody(provider, body)),
  });
}

async function handlePassthrough(req, env, provider, sub, search) {
  const cfg = PASSTHRU[provider];
  if (!cfg || !cfg.allow.some(([m, re]) => m === req.method && re.test(sub))) return json({ error: 'Route not allowed' }, 404);
  const key = resolveKey(req, env, provider);
  if (!key) return missingKey(req, env, provider);
  const headers = { ...cfg.auth(key), accept: req.headers.get('accept') || '*/*' };
  const init = { method: req.method, headers };
  if (req.method === 'POST') {
    headers['content-type'] = req.headers.get('content-type') || 'application/json';
    init.body = req.body;
  }
  // Only the download flag is forwarded as a query parameter.
  const qs = new URLSearchParams(search).get('alt') === 'media' ? '?alt=media' : '';
  return forward(`${cfg.base}/${sub}${qs}`, init);
}

// What the tester router borrows from the owner's proxy (passed in, so tester code never imports worker.js).
const UPSTREAM = { forward, shapeChatBody, CHAT_UPSTREAM, PROVIDERS, PASSTHRU };

// Brute-force guard: 10 wrong passcodes from one IP locks it out for 15 minutes.
const LOCK_LIMIT = 10;
const LOCK_SECONDS = 900;
async function passcodeGuard(req, env) {
  if (!req.headers.get('x-app-pass') || !env.APP_PASSCODE) return null;
  const key = `fail:${req.headers.get('cf-connecting-ip') || 'unknown'}`;
  const fails = Number((await env.ATELIER_KV.get(key)) || 0);
  if (fails >= LOCK_LIMIT) return json({ error: 'Too many wrong passcodes — try again in 15 minutes.' }, 429);
  if (!passOk(req, env)) await env.ATELIER_KV.put(key, String(fails + 1), { expirationTtl: LOCK_SECONDS });
  return null;
}

async function handleApi(req, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');

  const locked = await passcodeGuard(req, env);
  if (locked) return locked;

  if (path === 'health') {
    const server = Object.fromEntries(Object.entries(PROVIDERS).map(([n, p]) => [n, Boolean(env[p.secret] && env.APP_PASSCODE)]));
    return json({ ok: true, serverKey: server.nvidia, server });
  }

  // ── LinkedIn testers (docs/superpowers/specs/2026-09-30-atelier-tester-access-*.md) ──
  // Sign-in routes are public. Then: passcode → owner (wins over a tester cookie); a live tester cookie → the tester
  // router, which allows only its own list (deny by default); otherwise everything below behaves as it always has.
  if (path.startsWith('li/')) return handleLinkedIn(req, env, url, path);
  const who = await identify(req, env, passOk);
  if (who.kind === 'tester') return testerRouter(req, env, url, path, who, UPSTREAM);
  if (who.stale && !req.headers.get('x-app-pass')) return signedOut(); // an ended tester session, not a passcode problem
  if (path.startsWith('tester/')) return fail(401, 'tester_signin', 'Sign in with LinkedIn to use the tester routes.');
  // GET /api/testers, POST /api/testers/{revoke,restore,config} → the owner's Testers panel. Passcode only.
  if (path === 'testers' || path.startsWith('testers/')) {
    if (!passOk(req, env)) return json({ error: 'Enter your passcode.' }, 401);
    return testerAdmin(req, env, path);
  }

  // GET/PUT /api/me → the synced "You" profile (bio, writing style, memory). Passcode only.
  if (path === 'me') {
    if (!passOk(req, env)) return json({ error: 'Profile sync needs the server passcode.' }, 401);
    if (req.method === 'GET') return json((await env.ATELIER_KV.get('me', 'json')) || {});
    if (req.method === 'PUT') {
      const text = await req.text();
      if (text.length > 900_000) return json({ error: 'Profile too large' }, 413);
      try { JSON.parse(text); } catch { return json({ error: 'Bad JSON' }, 400); }
      await env.ATELIER_KV.put('me', text);
      return json({ ok: true });
    }
  }

  // Google OAuth callback (browser redirect — authenticated by the one-time state nonce, not the passcode).
  if (path === 'oauth/google/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code');
    const fail = (why) => { console.warn('google oauth callback failed:', why); return Response.redirect(`${url.origin}/?connected=error&why=${encodeURIComponent(String(why).slice(0, 120))}`, 302); };
    if (!SEG.test(state) || !(await env.ATELIER_KV.get(`oauth:${state}`))) return fail('sign-in link expired — start again from Settings');
    await env.ATELIER_KV.delete(`oauth:${state}`);
    if (!code) return Response.redirect(`${url.origin}/?connected=denied`, 302);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/api/oauth/google/callback`, grant_type: 'authorization_code' }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return fail(`token exchange ${r.status}: ${j.error_description || j.error || ''}`);
    if (!j.refresh_token) return fail('Google returned no refresh token');
    let email = '';
    try { email = await saveGoogleAccount(env, j.refresh_token, j.access_token, j.scope || ''); } catch (err) { return fail(`saving account: ${err.message}`); }
    return Response.redirect(`${url.origin}/?connected=gmail&account=${encodeURIComponent(email)}`, 302);
  }

  // Canva OAuth callback (browser redirect — authenticated by the single-use state, which also holds the PKCE verifier).
  if (path === 'oauth/canva/callback' && req.method === 'GET') {
    const fail = (why) => { console.warn('canva oauth callback failed:', why); return Response.redirect(`${url.origin}/?connected=error&why=${encodeURIComponent(String(why).slice(0, 120))}`, 302); };
    const pending = await canvaTakeState(env, url.searchParams.get('state') || '');
    const denied = url.searchParams.get('error');
    if (denied === 'access_denied') return Response.redirect(`${url.origin}/?connected=denied`, 302);
    if (denied) { // e.g. invalid_scope when the app's scopes in the Developer Portal don't match
      const detail = (url.searchParams.get('error_description') || '').replace(/[^\w .,:;'()-]/g, '');
      return fail(`Canva said ${denied.replace(/[^\w.-]/g, '').slice(0, 40)}${detail ? `: ${detail}` : ''}`);
    }
    if (!pending) return fail('sign-in link expired — start again from Settings');
    const code = url.searchParams.get('code') || '';
    if (!code || code.length > 4096) return fail('Canva returned no authorization code');
    try {
      const label = await canvaCompleteAuth(env, code, pending.verifier, `${url.origin}/api/oauth/canva/callback`);
      return Response.redirect(`${url.origin}/?connected=canva&account=${encodeURIComponent(label)}`, 302);
    } catch (err) { return fail(err instanceof CanvaError ? err.message : 'connecting Canva failed'); }
  }

  // ── Remote browser relay (extension on the user's computer ↔ Atelier on any device) ──
  const relay = () => env.RELAY.get(env.RELAY.idFromName('main'));

  // GET /api/relay/ws → the extension's persistent connection. The relay itself checks the device token, which only
  // travels as a WebSocket subprotocol: no query string is passed on.
  if (path === 'relay/ws') return relay().fetch(new Request('https://relay/ws', req));

  if (path.startsWith('relay/')) {
    if (!passOk(req, env)) return json({ error: 'Enter your passcode.' }, 401);

    // POST /api/relay/pair → new device token for the extension (replaces any previous one)
    if (path === 'relay/pair' && req.method === 'POST') {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      await relay().fetch('https://relay/token', { method: 'PUT', body: token });
      return json({ token });
    }

    // GET /api/relay/status → is the computer's browser connected?
    if (path === 'relay/status' && req.method === 'GET') return relay().fetch('https://relay/status');

    // POST /api/relay/cmd {cmd, args, approved} → run a browser command on the computer
    if (path === 'relay/cmd' && req.method === 'POST') {
      const { cmd, args, approved } = await req.json().catch(() => ({}));
      const allowed = ['tabs', 'read', 'open', 'elements', 'describe', 'click', 'type', 'show'];
      if (!allowed.includes(cmd)) return json({ ok: false, error: 'Unknown browser command' }, 400);
      if ((cmd === 'click' || cmd === 'type') && approved !== true) return json({ ok: false, error: 'This action needs your approval in the app.' }, 403);
      return relay().fetch('https://relay/cmd', { method: 'POST', body: JSON.stringify({ cmd, args: args || {} }) });
    }
    return json({ error: 'Not found' }, 404);
  }

  // GET /api/diag → verify each stored provider key with a free "list models" call (passcode only).
  if (path === 'diag' && req.method === 'GET') {
    if (!passOk(req, env)) return json({ error: 'Enter your passcode.' }, 401);
    const check = async (url, headers) => {
      try {
        const r = await fetch(url, { headers });
        if (r.ok) return { ok: true, status: r.status };
        const t = await r.text();
        let msg = t;
        try { const j = JSON.parse(t); const e = Array.isArray(j) ? j[0]?.error : j.error; msg = e?.message || j.detail || j.message || t; } catch {}
        return { ok: false, status: r.status, message: String(msg).slice(0, 300) };
      } catch (err) { return { ok: false, status: 0, message: err.message }; }
    };
    const out = {};
    if (env.ANTHROPIC_API_KEY) out.anthropic = await check('https://api.anthropic.com/v1/models?limit=1', {
      'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
      ...(env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : {}),
    });
    if (env.OPENAI_API_KEY) out.openai = await check('https://api.openai.com/v1/models', { authorization: `Bearer ${env.OPENAI_API_KEY}` });
    if (env.GEMINI_API_KEY) {
      out.gemini = await check('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': env.GEMINI_API_KEY });
      if (out.gemini.ok) out.veo = await check('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite-generate-preview', { 'x-goog-api-key': env.GEMINI_API_KEY });
      const k = env.GEMINI_API_KEY;
      // AI Studio issues "auth keys" (AQ.…) since May 2026; Google is retiring the older AIza… standard keys.
      out.gemini.keyShape = /^\s|\s$/.test(k) ? 'has leading/trailing whitespace'
        : /^AQ\.[\w.-]{20,}$/.test(k) ? 'Google auth key (AQ.) — current format'
        : /^AIza[\w-]{35}$/.test(k) ? 'older AIza key — Google is retiring these; make a new key in AI Studio'
        : `unusual format (${k.length} chars)`;
    }
    if (env.ZAI_API_KEY) out.zai = await (async () => {
      // No free list endpoint — a 1-token call on the free GLM-4.7-Flash model.
      try {
        const r = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
          method: 'POST', headers: { authorization: `Bearer ${env.ZAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, thinking: { type: 'disabled' } }),
        });
        if (r.ok) return { ok: true, status: r.status };
        const t = await r.text();
        let msg = t; try { const j = JSON.parse(t); msg = j.error?.message || j.msg || j.message || t; } catch {}
        return { ok: false, status: r.status, message: String(msg).slice(0, 300) };
      } catch (err) { return { ok: false, status: 0, message: err.message }; }
    })();
    if (env.DEEPSEEK_API_KEY) {
      out.deepseek = await check('https://api.deepseek.com/user/balance', { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` });
      if (out.deepseek.ok) {
        const bal = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${env.DEEPSEEK_API_KEY}` } }).then((r) => r.json()).catch(() => null);
        if (bal && !bal.is_available) out.deepseek = { ok: false, status: 402, message: 'Key works but the account has no balance — top up at platform.deepseek.com.' };
      }
    }
    if (env.META_API_KEY) out.meta = await check('https://api.meta.ai/v1/models', { authorization: `Bearer ${env.META_API_KEY}` });
    if (env.NVIDIA_API_KEY) out.nvidia = { ok: /^nvapi-/.test(env.NVIDIA_API_KEY), status: 0, message: 'format check only' };
    return json(out);
  }

  // Everything account-related below needs the server passcode.
  if (path.startsWith('tools') || path.startsWith('oauth/') || path.startsWith('accounts/') || path.startsWith('photos/') || path.startsWith('canva/')) {
    if (!passOk(req, env)) return json({ error: 'Connected accounts need the server passcode.' }, 401);

    // GET /api/tools → which services are connected + tool definitions
    if (path === 'tools' && req.method === 'GET') return json(await toolList(env));

    // POST /api/tools/run {name, args, approved} → run one tool server-side
    if (path === 'tools/run' && req.method === 'POST') {
      const { name, args, approved } = await req.json().catch(() => ({}));
      if (typeof name !== 'string') return json({ ok: false, error: 'Tool name required' }, 400);
      return json(await runTool(env, name, args, approved));
    }

    // POST /api/oauth/google/start → consent URL with a one-time state nonce
    if (path === 'oauth/google/start' && req.method === 'POST') {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.' }, 400);
      const state = crypto.randomUUID().replace(/-/g, '');
      await env.ATELIER_KV.put(`oauth:${state}`, '1', { expirationTtl: 600 });
      const q = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/api/oauth/google/callback`, response_type: 'code',
        scope: GOOGLE_SCOPES, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
      });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
    }

    // POST /api/oauth/canva/start → Canva consent URL (PKCE S256 + single-use state)
    if (path === 'oauth/canva/start' && req.method === 'POST') {
      if (!canvaConfigured(env)) return json({ error: 'Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET first.' }, 400);
      // Canva rejects localhost redirect URLs; local development has to use 127.0.0.1.
      if (url.hostname === 'localhost') return json({ error: `Canva doesn’t accept localhost — open Atelier at http://127.0.0.1${url.port ? `:${url.port}` : ''} to connect Canva.` }, 400);
      return json({ url: await canvaAuthUrl(env, `${url.origin}/api/oauth/canva/callback`) });
    }

    // DELETE /api/oauth/canva?id=… → disconnect one Canva account (or all without ?id), revoking it at Canva
    if (path === 'oauth/canva' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (id !== null && !CANVA_ID.test(id)) return json({ error: 'Bad Canva account id' }, 400);
      return json({ ok: true, accounts: await removeCanvaAccount(env, id) });
    }

    // POST /api/canva/send-image {image: data URL, title?, account?} → new Canva design holding the image
    if (path === 'canva/send-image' && req.method === 'POST') {
      // 25 MB of image is ~33.4 MB of base64; leave room for the JSON around it.
      if (Number(req.headers.get('content-length') || 0) > Math.ceil(CANVA_MAX_IMAGE * 4 / 3) + 64 * 1024) return json({ error: 'Image is too large for Canva (max 25 MB).' }, 400);
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad JSON body' }, 400);
      try {
        return json(await canvaSendImage(env, body));
      } catch (err) {
        if (!(err instanceof CanvaError)) console.error('canva send-image failed', String(err?.message || err).slice(0, 200));
        const status = err instanceof CanvaError && [400, 401, 403, 429].includes(err.status) ? err.status : 502;
        return json({ error: err instanceof CanvaError ? err.message : 'Sending to Canva failed — try again.' }, status);
      }
    }

    // ── Library "From Canva": browse designs, import one, and stream its export files (Canva links need no token) ──
    // GET /api/canva/designs?query=&continuation=&account= → { account, items, continuation }
    if (path === 'canva/designs' && req.method === 'GET') {
      const sp = url.searchParams;
      try {
        return json(await canvaListDesigns(env, { query: sp.get('query') ?? '', continuation: sp.get('continuation') ?? '', account: sp.get('account') ?? '' }));
      } catch (err) { return canvaFail(err, 'Loading your Canva designs failed — try again.'); }
    }
    // GET /api/canva/designs/<id>/formats?account= → { title, page_count, formats }
    const canvaFormats = path.match(/^canva\/designs\/([^/]+)\/formats$/);
    if (canvaFormats && req.method === 'GET') {
      if (!CANVA_ID.test(canvaFormats[1])) return json({ error: 'Bad Canva design id' }, 400);
      try {
        return json(await canvaDesignFormats(env, canvaFormats[1], url.searchParams.get('account') ?? ''));
      } catch (err) { return canvaFail(err, 'Checking that design failed — try again.'); }
    }
    // POST /api/canva/import {design_id, format: png|mp4, pages?, account?} → { title, format, files: [/api/canva/file?u=…], truncated }
    if (path === 'canva/import' && req.method === 'POST') {
      if (Number(req.headers.get('content-length') || 0) > 16 * 1024) return json({ error: 'Request too large' }, 400);
      const text = await req.text().catch(() => '');
      if (text.length > 16 * 1024) return json({ error: 'Request too large' }, 400);
      let body = null;
      try { body = JSON.parse(text); } catch {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad JSON body' }, 400);
      try {
        return json(await canvaImport(env, body));
      } catch (err) { return canvaFail(err, 'Importing from Canva failed — try again.'); }
    }
    // GET /api/canva/file?u=<Canva export link> → the file's bytes (PNG / JPEG / MP4, ≤ 100 MB, export host only)
    if (path === 'canva/file' && req.method === 'GET') {
      try {
        return await canvaFetchFile(url.searchParams.get('u') || '');
      } catch (err) { return canvaFail(err, 'Downloading from Canva failed — try again.'); }
    }

    // POST /api/accounts/:svc {token} → add another GitHub / Cloudflare account; DELETE /api/accounts/:svc/:id → remove it
    let m = path.match(/^accounts\/(github|cloudflare)(?:\/([\w-]{1,40}))?$/);
    if (m) {
      try {
        if (req.method === 'POST' && !m[2]) {
          const { token } = await req.json().catch(() => ({}));
          return json({ ok: true, label: await addTokenAccount(env, m[1], token) });
        }
        if (req.method === 'DELETE' && m[2] && m[2] !== 'primary') return json({ ok: true, remaining: await removeTokenAccount(env, m[1], m[2]) });
      } catch (err) { return json({ ok: false, error: err.message }, 400); }
      return json({ error: 'Not found' }, 404);
    }

    // ── Google Photos Picker: the user picks photos in Google's own UI; Atelier only sees the picked items ──
    const photos = async (account, p, init = {}) => {
      const { token } = await googleTokenFor(env, account);
      const r = await fetch(`https://photospicker.googleapis.com/v1/${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
      const t = await r.text();
      if (!r.ok) {
        let msg = t; try { msg = JSON.parse(t).error?.message || t; } catch {}
        if (r.status === 403 && /scope|insufficient/i.test(msg)) msg = 'This Google account hasn’t allowed Photos yet — reconnect it with “+ Add account” in Settings → Connections.';
        else if (r.status === 403 && /disabled|not been used/i.test(msg)) {
          const project = msg.match(/project (\d+)/)?.[1];
          msg = `Google says the Photos Picker API isn’t enabled${project ? ` in project ${project}` : ''} (the project that owns your OAuth client). If you just enabled it, wait a few minutes.`;
        }
        throw Object.assign(new Error(String(msg).slice(0, 300)), { status: r.status });
      }
      return t ? JSON.parse(t) : {};
    };
    m = path.match(/^photos\/(session|items|file)(?:\/([\w-]{1,120}))?$/);
    if (m) {
      const account = url.searchParams.get('account') || undefined;
      try {
        // POST /api/photos/session → {id, pickerUri, pollingConfig}
        if (m[1] === 'session' && req.method === 'POST') return json(await photos(account, 'sessions', { method: 'POST', body: '{}' }));
        // GET /api/photos/session/:id → {mediaItemsSet, pollingConfig}
        if (m[1] === 'session' && m[2] && req.method === 'GET') return json(await photos(account, `sessions/${m[2]}`));
        if (m[1] === 'session' && m[2] && req.method === 'DELETE') return json(await photos(account, `sessions/${m[2]}`, { method: 'DELETE' }));
        // GET /api/photos/items?session= → picked items
        if (m[1] === 'items' && req.method === 'GET') {
          const sid = url.searchParams.get('session') || '';
          if (!/^[\w-]{1,120}$/.test(sid)) return json({ error: 'session required' }, 400);
          const j = await photos(account, `mediaItems?sessionId=${sid}&pageSize=50`);
          return json({ items: (j.mediaItems || []).map((i) => ({ id: i.id, type: i.type, baseUrl: i.mediaFile?.baseUrl, mimeType: i.mediaFile?.mimeType, filename: i.mediaFile?.filename })) });
        }
        // GET /api/photos/file?u=<baseUrl> → the image bytes (baseUrls need the OAuth token, so the Worker fetches them)
        if (m[1] === 'file' && req.method === 'GET') {
          let u;
          try { u = new URL(url.searchParams.get('u') || ''); } catch { return json({ error: 'bad url' }, 400); }
          if (u.protocol !== 'https:' || !/(^|\.)googleusercontent\.com$/.test(u.hostname)) return json({ error: 'bad url' }, 400);
          const { token } = await googleTokenFor(env, account);
          const r = await fetch(`${u.href}=w2048-h2048`, { headers: { authorization: `Bearer ${token}` }, redirect: 'follow' });
          if (!r.ok) return json({ error: `Photo fetch failed (${r.status})` }, 502);
          return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, no-store' } });
        }
      } catch (err) { return json({ error: err.message }, err.status && err.status < 500 ? err.status : 502); }
      return json({ error: 'Not found' }, 404);
    }

    // DELETE /api/oauth/google?email=… → disconnect one Gmail account (or all without ?email)
    if (path === 'oauth/google' && req.method === 'DELETE') {
      return json({ ok: true, accounts: await removeGoogleAccount(env, url.searchParams.get('email')) });
    }
    return json({ error: 'Not found' }, 404);
  }

  // /api/video/* → chat videos uploaded to Gemini's Files API (passcode + Gemini key). handleVideoApi reads chunk
  // bodies itself into one capped buffer, so nothing may touch req.body before it.
  if (path.startsWith('video/')) {
    if (!resolveKey(req, env, 'gemini')) return missingKey(req, env, 'gemini');
    return handleVideoApi(req, env, path, url.searchParams);
  }

  // POST /api/chat → routed by model prefix (anthropic: / openai: / gemini: / NVIDIA default)
  if (path === 'chat' && req.method === 'POST') return handleChat(req, env);
  // POST /api/tts {voice, text} | {voice, preview: true} → read aloud in the Atelier voice (src/tts.js; testers never get here)
  if (path === 'tts' && req.method === 'POST') return passOk(req, env) ? handleTts(req, env) : missingKey(req, env, 'openai');

  // /api/x/<provider>/<path> → allow-listed image / video endpoints for OpenAI and Gemini
  const x = path.match(/^x\/(openai|gemini|meta)\/(.+)$/);
  if (x) return handlePassthrough(req, env, x[1], x[2], url.search);

  // Everything below is NVIDIA.
  const key = resolveKey(req, env, 'nvidia');
  if (!key) return missingKey(req, env, 'nvidia');
  const nv = (target, withBody) =>
    forward(target, {
      method: req.method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: req.headers.get('accept') || 'application/json',
        ...(withBody ? { 'content-type': 'application/json' } : {}),
        ...(req.headers.get('nvcf-poll-seconds') ? { 'nvcf-poll-seconds': req.headers.get('nvcf-poll-seconds') } : {}),
      },
      body: withBody ? req.body : undefined,
    });

  // GET /api/models → NVIDIA catalog
  if (path === 'models' && req.method === 'GET') return nv(`${NVIDIA.chat}/models`);

  // POST /api/genai/<org>/<model>[/<sub>] → NVIDIA visual generation
  if (path.startsWith('genai/') && req.method === 'POST') {
    const parts = path.slice(6).split('/');
    if (parts.length < 2 || parts.length > 3 || !parts.every((p) => SEG.test(p))) return json({ error: 'Bad model path' }, 400);
    return nv(`${NVIDIA.genai}/${parts.join('/')}`, true);
  }

  // POST /api/fn/<name> → allow-listed NVCF functions (e.g. Cosmos video)
  if (path.startsWith('fn/') && req.method === 'POST') {
    const name = path.slice(3);
    if (!Object.hasOwn(FUNCTIONS, name)) return json({ error: 'Unknown function' }, 404);
    return nv(`${NVIDIA.nvcf}/pexec/functions/${FUNCTIONS[name]}`, true);
  }

  // GET /api/status/<request-id> → poll a long-running (202) NVCF job
  if (path.startsWith('status/') && req.method === 'GET') {
    const id = path.slice(7);
    if (!SEG.test(id)) return json({ error: 'Bad request id' }, 400);
    return nv(`${NVIDIA.nvcf}/pexec/status/${id}`);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        const response = await handleApi(req, env, url);
        if (response.status === 101) return response;
        const secured = new Response(response.body, response); // keeps the route's headers (content-type, retry-after…)
        // Keep a stricter no-store policy a route set itself (e.g. "private, no-store" on proxied files).
        if (!/\bno-store\b/i.test(secured.headers.get('Cache-Control') || '')) secured.headers.set('Cache-Control', 'no-store');
        secured.headers.set('X-Content-Type-Options', 'nosniff');
        secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        return secured;
      } catch (err) {
        return json({ error: err.message || 'Proxy error' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
