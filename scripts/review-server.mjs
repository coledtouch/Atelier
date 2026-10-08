// Isolated UI fixture: no credentials, external API calls, or production data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Readable } from 'node:stream';
import { handleFeedback } from '../src/feedback.js';
import { cleanProfile, EMPTY_PROFILE } from '../src/tester/profile.js';
import { shapeRequest as runwayShape, quote as runwayQuote, ownerQuote as runwayOwnerQuote } from '../src/runway.js';
import * as Spend from '../src/spend.js';
import { shapeOmni, ownerQuote as omniOwnerQuote } from '../src/omni.js';
import { videoQuoteMicros } from '../src/xai.js';
const root = resolve('public');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// REVIEW_SYNC=1 enables owner sync; REVIEW_TESTER=<subject> enables simulated tester sign-in and private sync.
// REVIEW_PROVIDERS=1 (or --providers) reports Anthropic, OpenAI, Gemini, Runway and xAI as configured for the owner too (Video mode's
// Omni, Runway and Grok menus, Settings → models and voices); their /api/omni, /api/runway, /api/xai and /api/tts calls get local stubs below.
// It also connects a stub Gmail with one read-only tool (gmail_search): an inbox question goes to the accounts agent, whose
// /api/chat turn calls that tool once, so its approval cards can be checked. No Gmail is ever read.
// Both run the real src/sync.js over separate account buckets in memory (tests/fake-r2.mjs), shared by every browser
// profile on this port; restarting empties them. workerRequest gives a body with a Content-Length the known length the
// Workers runtime would (the strict fake, like R2, refuses a stream without one).
// --providers also checks Claude's stop reasons through the real Worker adapter (src/anthropic.js claudeChat) and a local
// stand-in for the Anthropic Messages API (claudeStandIn below): fetches to api.anthropic.com are answered in-process and
// never leave this machine; nothing else is rerouted. A Claude request (Code mode → Claude Opus 5.5; Ask with "news" or
// "today" → Claude Sonnet 5.5 + web; an inbox question → the accounts agent on Sonnet) whose prompt holds a trigger gets:
//   "claude think only"     thinking only, cut at max_tokens, until the app's nudge: then the answer (agent: gmail_search)
//   "claude think forever"  thinking only every time (the app nudges, moves to the next model, then says no answer came)
//   "claude cut off"        an answer cut at max_tokens (the "hit the length limit" note)
//   "claude refuse"         declined before any text (the "Try rephrasing" card); "claude refuse late": after some text
//   "claude pause"          a web search that pauses the turn (pause_turn); the Worker continues it and the answer completes
//   "claude long thread"    model_context_window_exceeded before any text
const CLAUDE_TRIGGER = /\bclaude (think only|think forever|cut off|refuse late|refuse|pause|long thread)\b/i;
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '');
// The person's own prompt: the last user text that isn't the app's empty-answer nudge (tool results have no text).
const promptOf = (messages = []) => [...messages].reverse().map((m) => (m?.role === 'user' ? textOf(m.content) : '')).find((t) => t && !/wrote no answer/.test(t)) || '';
const sseEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function claudeStream(blocks, stop) {
  const out = [sseEvent('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } })];
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      out.push(sseEvent('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
      for (const part of b.thinking.match(/.{1,40}/gs)) out.push(sseEvent('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: part } }));
      out.push(sseEvent('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'fixture-signature' } }));
    } else if (b.type === 'text') {
      out.push(sseEvent('content_block_start', { index, content_block: { type: 'text', text: '' } }));
      for (const part of b.text.match(/.{1,24}/gs)) out.push(sseEvent('content_block_delta', { index, delta: { type: 'text_delta', text: part } }));
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      out.push(sseEvent('content_block_start', { index, content_block: { type: b.type, id: b.id, name: b.name, input: {} } }));
      out.push(sseEvent('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }));
    } else out.push(sseEvent('content_block_start', { index, content_block: b }));
    out.push(sseEvent('content_block_stop', { index }));
  });
  const details = stop === 'refusal' ? { stop_details: { type: 'refusal', category: null, explanation: 'Local fixture refusal.' } } : {};
  out.push(sseEvent('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...details }, usage: { output_tokens: 400 } }), sseEvent('message_stop', {}));
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ async pull(c) { if (!out.length) return c.close(); await new Promise((r) => setTimeout(r, 30)); c.enqueue(enc.encode(out.shift())); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const PLAN = 'Planning the answer: the files it needs, the edge cases, the tests, what to leave out… (local fixture thinking) ';
async function claudeStandIn(request) {
  const b = await request.json();
  const which = (promptOf(b.messages).match(CLAUDE_TRIGGER)?.[1] || '').toLowerCase();
  const last = b.messages?.at(-1) || {};
  const nudged = /wrote no answer/.test(textOf(last.content));
  const afterTool = last.role === 'user' && Array.isArray(last.content) && last.content.some((x) => x?.type === 'tool_result');
  const agent = Array.isArray(b.tools) && b.tools.some((t) => t.name === 'gmail_search');
  const think = (t = PLAN) => ({ type: 'thinking', thinking: t });
  const answer = { type: 'text', text: 'Local fixture answer from Claude, after the nudge. No provider was called.\n\n```js\nconst ok = true;\n```' };
  if (afterTool) return claudeStream([think('Reading the result. '), { type: 'text', text: 'You have 2 unread messages (local fixture — no Gmail was read).' }], 'end_turn');
  if (which === 'think only') {
    if (!nudged) return claudeStream([think(PLAN.repeat(3))], 'max_tokens');
    return agent ? claudeStream([think('Short pass. '), { type: 'tool_use', id: 'toolu_fixture_1', name: 'gmail_search', input: { q: 'is:unread newer_than:2d' } }], 'tool_use')
      : claudeStream([think('Short pass. '), answer], 'end_turn');
  }
  if (which === 'think forever') return claudeStream([think(PLAN.repeat(3))], 'max_tokens');
  if (which === 'cut off') return claudeStream([think(), { type: 'text', text: 'Here is the first part of a long answer: step one, step two, and then step thr' }], 'max_tokens');
  if (which === 'refuse') return claudeStream([], 'refusal');
  if (which === 'refuse late') return claudeStream([think(), { type: 'text', text: 'Here is how it starts' }], 'refusal');
  if (which === 'long thread') return claudeStream([think()], 'model_context_window_exceeded');
  if (which === 'pause') {
    if (last.role === 'assistant') return claudeStream([{ type: 'text', text: 'and here is the rest, after the paused search resumed. Completed answer (local fixture).' }], 'end_turn');
    return claudeStream([think('Searching first. '), { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: { query: 'local fixture news' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [{ type: 'web_search_result', url: 'https://example.com/fixture', title: 'Fixture', encrypted_content: 'x', page_age: null }] },
      { type: 'text', text: 'Found a source (paused here), ' }], 'pause_turn');
  }
  return claudeStream([{ type: 'text', text: 'Local fixture answer from Claude.' }], 'end_turn');
}
if (Boolean(process.env.REVIEW_PROVIDERS) || process.argv.includes('--providers')) {
  const passFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    return new URL(href).hostname === 'api.anthropic.com' ? claudeStandIn(input instanceof Request ? input : new Request(href, init)) : passFetch(input, init);
  };
}
// The stub Gmail tool --providers connects (the Worker's real tool list is far longer; this one is read-only).
const FIXTURE_GMAIL ={ type: 'function', function: { name: 'gmail_search', description: 'Search the user’s Gmail (local fixture).', parameters: { type: 'object', properties: { q: { type: 'string', description: 'Gmail search query' } }, required: ['q'], additionalProperties: false } }, 'x-write': false, 'x-label': 'Search Gmail', 'x-service': 'gmail' };
const syncEnvs = new Map(), profiles = new Map(), feedback = new Map(), omniJobs = new Map(), xaiJobs = new Map(), runwayJobs = new Map(), omniRows = new Map();
// Owner spending limits (src/spend.js; Settings → Spending): the Worker's own rules and words (decide, capRefusal,
// cleanLimits, the price quotes) over an in-memory month. REVIEW_SPENT=<usd> starts this month with that much spent, so
// the monthly refusal can be seen; a refused job never reaches its stub below.
const owner = { limits: { ...Spend.DEFAULT_LIMITS, updatedAt: null }, rows: [] };
if (Number(process.env.REVIEW_SPENT) > 0) owner.rows.push({ provider: 'runway', kind: 'video', amount: Spend.toMicros(process.env.REVIEW_SPENT), actual: Spend.toMicros(process.env.REVIEW_SPENT), month: Spend.monthOf() });
const monthSpent = (m = Spend.monthOf()) => owner.rows.filter((r) => r.month === m).reduce((n, r) => n + (r.actual ?? r.amount), 0);
// → the row held for the job, or a SpendError (402 owner_cap_video / owner_cap_month) to answer with.
function spendStart(provider, kind, amount) {
  const month = Spend.monthOf(), spent = monthSpent(month), d = Spend.decide({ amount, kind, limits: owner.limits, spent });
  if (!d.ok) return Spend.capRefusal({ limit: d.limit, amount, limits: owner.limits, spent, month, provider, kind });
  const row = { provider, kind, amount, actual: null, month };
  owner.rows.push(row);
  return row;
}
const refuse = (res, err) => { res.statusCode = err.status; return res.end(JSON.stringify(err.body)); };
const fixtureTester = process.env.REVIEW_TESTER || '';
let testerActive = Boolean(fixtureTester);
const feedbackEnv = { ATELIER_KV: {
  async get(key) { return feedback.get(key) || null; },
  async put(key, value) { feedback.set(key, value); },
  async delete(key) { feedback.delete(key); },
  async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...feedback.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) }; },
} };
const fixtureMe = () => ({
  sub: fixtureTester, name: 'Review tester', email: 'review@example.test', picture: '',
  models: { chat: ['anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5', 'openai:gpt-6.1-sol'], image: ['openai:gpt-image-2.5-flare', 'openai:gpt-image-2.5-sunburst', 'gemini:gemini-nano-banana-2.1'], video: ['gemini:gemini-omni-1.1-flash'], tts: ['atelier', 'sulafat'] },
  features: { web: true, video: true, veo: true, helpers: true, profile: true, tts: true, dictation: true, sync: true },
  allowance: { day: { spent: 0, reserved: 0, limit: 5_000_000 }, month: { spent: 0, reserved: 0, limit: 50_000_000 }, pool: { spent: 0, reserved: 0, limit: 100_000_000 } },
  pool: { paused: false, preview: false, spotsLeft: 24 },
});
const fixtureIdentity = (req) => req.headers['x-app-pass'] === 'review-only' ? { role: 'owner' } : testerActive ? { role: 'tester', sub: fixtureTester } : null;
function workerRequest(req, url) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  return new Request(url.href, { method: req.method, headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'), body, ...(body ? { duplex: 'half' } : {}) });
}
async function writeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}
async function reviewSync(req, res, url, account = 'owner') {
  const [{ handleSync }, { fakeR2, workerRequest }] = await Promise.all([import('../src/sync.js'), import('../tests/fake-r2.mjs')]);
  if (!syncEnvs.has(account)) syncEnvs.set(account, { SYNC_BUCKET: fakeR2(), SYNC_QUOTA_BYTES: account === 'owner' ? '53687091200' : '1073741824' });
  const syncEnv = syncEnvs.get(account);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  const headers = Object.entries(req.headers).filter(([, v]) => typeof v === 'string');
  const suffix = url.pathname.startsWith('/api/tester/sync/') ? url.pathname.slice('/api/tester/sync/'.length) : url.pathname.replace(/^\/api\/sync\/?/, '');
  const r = await handleSync(workerRequest(url.href, { method: req.method, headers, body, ...(body ? { duplex: 'half' } : {}) }), syncEnv, suffix);
  return writeResponse(res, r);
}
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const allProviders = Boolean(process.env.REVIEW_PROVIDERS) || process.argv.includes('--providers');
    if (url.pathname === '/api/health') return res.end(JSON.stringify({ server: { nvidia: true, ...(process.env.REVIEW_STT || fixtureTester || allProviders ? { openai: true } : {}), ...(fixtureTester || allProviders ? { anthropic: true, gemini: true } : {}), ...(allProviders ? { runway: true, xai: true } : {}) } }));
    if (url.pathname === '/api/li/spots') return res.end('{"spotsLeft":24,"cap":25,"paused":false}');
    // REVIEW_TESTER=<subject> is a local, simulated session. No LinkedIn call or production cookie is used.
    if (url.pathname === '/api/li/start' && fixtureTester) { testerActive = true; res.statusCode = 303; res.setHeader('Location', '/?tester=welcome'); return res.end(); }
    if (url.pathname === '/api/li/logout' && req.method === 'POST') { testerActive = false; res.statusCode = 204; return res.end(); }
    if (url.pathname === '/api/tester/me') { if (!testerActive) { res.statusCode = 401; return res.end('{"error":"No local tester session.","code":"tester_signin"}'); } return res.end(JSON.stringify(fixtureMe())); }
    const identity = fixtureIdentity(req);
    if (!identity) { res.statusCode = 401; return res.end('{"error":"Wrong passcode"}'); }
    if (url.pathname === '/api/feedback') return writeResponse(res, await handleFeedback(workerRequest(req, url), feedbackEnv, identity));
    if (url.pathname === '/api/tester/profile') {
      if (identity.role !== 'tester') { res.statusCode = 403; return res.end('{"error":"Use the local tester session."}'); }
      if (req.method === 'GET') return res.end(JSON.stringify(profiles.get(identity.sub) || EMPTY_PROFILE));
      if (req.method === 'PUT') {
        const parts = []; for await (const chunk of req) parts.push(chunk);
        let profile;
        try { profile = cleanProfile(JSON.parse(Buffer.concat(parts).toString())); } catch {}
        if (!profile) { res.statusCode = 400; return res.end('{"error":"Bad profile."}'); }
        profiles.set(identity.sub, profile); return res.end('{"ok":true}');
      }
      res.statusCode = 405; return res.end('{"error":"Use GET or PUT."}');
    }
    if (url.pathname.startsWith('/api/tester/sync/')) {
      if (identity.role !== 'tester') { res.statusCode = 403; return res.end('{"error":"Use the local tester session."}'); }
      return reviewSync(req, res, url, `tester:${identity.sub}`);
    }
    if (url.pathname === '/api/sync' || url.pathname.startsWith('/api/sync/')) {
      if (identity.role !== 'owner') { res.statusCode = 403; return res.end('{"error":"Use the local owner passcode."}'); }
      if (!process.env.REVIEW_SYNC) { res.statusCode = 503; return res.end('{"error":"Sync isn’t set up on the server yet.","code":"sync_unconfigured"}'); }
      return reviewSync(req, res, url);
    }
    if (url.pathname === '/api/lookup/img') {
      if (!url.searchParams.get('k')) { res.statusCode = 400; return res.end('{"error":"That isn’t a Look up image.","code":"lookup_query"}'); }
      res.setHeader('Content-Type', 'image/png'); return res.end(await readFile(resolve(root, 'icons/atelier-v2-512.png')));
    }
    if (url.pathname === '/api/lookup') {
      const raw = url.searchParams.get('q') || url.searchParams.get('title') || '', q = raw.toLowerCase();
      const lic = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };
      const img = { src: '/api/lookup/img?k=fixture-512', width: 512, height: 512, srcset: [[512, '/api/lookup/img?k=fixture-512']], file: 'Fixture.png', page: 'https://commons.wikimedia.org/wiki/File:Fixture.png', mat: true };
      if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Select a word or a short name to look up.', code: 'lookup_query' })); }
      if (q.includes('slow')) await new Promise((r) => setTimeout(r, 1500));
      if (q.includes('fail')) { res.statusCode = 502; return res.end(JSON.stringify({ error: 'Couldn’t reach Wikipedia — try again.', code: 'lookup_unavailable' })); }
      if (q.includes('busy')) { res.statusCode = 429; res.setHeader('Retry-After', '5'); return res.end(JSON.stringify({ error: 'Wikipedia is busy — try again in a few seconds.', code: 'lookup_busy', retryAfter: 5 })); }
      if (q.includes('zzz')) return res.end(JSON.stringify({ v: 1, found: false, lang: 'en', query: raw, search: 'https://en.wikipedia.org/w/index.php?search=zzz&ns0=1', others: [{ title: 'Sleep', description: 'Fixture alternative' }] }));
      if (q === 'mercury') return res.end(JSON.stringify({ v: 1, found: true, kind: 'choices', lang: 'en', dir: 'ltr', query: raw, title: 'Mercury', url: 'https://en.wikipedia.org/wiki/Mercury', choices: [{ title: 'Mercury (planet)', description: 'Smallest planet, nearest the Sun' }, { title: 'Mercury (element)', description: 'Chemical element with symbol Hg' }, { title: 'Freddie Mercury', description: 'British singer (1946–1991)' }], license: lic }));
      const search = q.startsWith('nero') && !q.includes('(');
      const title = url.searchParams.get('title') || 'Domus Aurea';
      return res.end(JSON.stringify({ v: 1, found: true, kind: 'article', via: search ? 'search' : q.includes('(') ? 'inner' : 'title', lang: 'en', dir: 'ltr', query: raw, title, description: 'Roman palace (fixture)', extract: 'Local fixture summary. No Wikipedia call was made. A third sentence checks the three-line clamp on phones and the four-line clamp on desktop.', trimmed: true, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, image: q.includes('plain') ? null : img, others: search ? [{ title: 'Palace Tomb', description: 'Fixture alternative' }, { title: 'Nero', description: 'Roman emperor' }] : [], license: lic }));
    }
    // Settings → Spending (owner only; a tester gets the router's 403 owner_only, as in production)
    if (url.pathname.startsWith('/api/owner/')) {
      if (identity.role !== 'owner') { res.statusCode = 403; return res.end('{"error":"That part of Atelier is only for its owner.","code":"owner_only"}'); }
      if (url.pathname === '/api/owner/limits' && req.method === 'GET') return res.end(JSON.stringify({ ...owner.limits, defaults: Spend.DEFAULT_LIMITS, bounds: Spend.LIMIT_BOUNDS }));
      if (url.pathname === '/api/owner/limits' && req.method === 'PUT') {
        const parts = []; for await (const p of req) parts.push(p);
        let b = null; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
        const r = Spend.cleanLimits(b, owner.limits);
        if (!r.ok) { res.statusCode = 400; return res.end(JSON.stringify({ error: r.error, code: 'owner_limits_input' })); }
        owner.limits = { ...r.limits, updatedAt: Date.now() };
        return res.end(JSON.stringify({ ok: true, ...owner.limits, ...(r.clamped ? { clamped: true } : {}) }));
      }
      if (url.pathname === '/api/owner/spend' && req.method === 'GET') {
        const m = Spend.monthOf(), rows = owner.rows.filter((r) => r.month === m), total = monthSpent(m), held = rows.filter((r) => r.actual == null).reduce((n, r) => n + r.amount, 0);
        const groups = new Map();
        for (const r of rows) { const k = `${r.provider}/${r.kind}`, g = groups.get(k) || { provider: r.provider, kind: r.kind, total: 0, held: 0, jobs: 0 }; g.total += r.actual ?? r.amount; g.held += r.actual == null ? r.amount : 0; g.jobs++; groups.set(k, g); }
        return res.end(JSON.stringify({ month: m, resetsAt: Spend.resetsAt(m), limits: { perVideoUsd: owner.limits.perVideoUsd, monthlyMediaUsd: owner.limits.monthlyMediaUsd },
          totalUsd: Spend.toUsd(total), settledUsd: Spend.toUsd(total - held), heldUsd: Spend.toUsd(held), leftUsd: Spend.toUsd(Math.max(0, Spend.toMicros(owner.limits.monthlyMediaUsd) - total)), jobs: rows.length,
          byProvider: [...groups.values()].sort((a, b) => b.total - a.total).map((g) => ({ provider: g.provider, kind: g.kind, usd: Spend.toUsd(g.total), heldUsd: Spend.toUsd(g.held), jobs: g.jobs })) }));
      }
      res.statusCode = 404; return res.end('{"error":"Not found"}');
    }
    if (url.pathname === '/api/me') {
      if (identity.role !== 'owner') { res.statusCode = 403; return res.end('{"error":"Use the local owner passcode."}'); }
      return res.end('{}');
    }
    if (url.pathname === '/api/tools') return res.end(allProviders ? JSON.stringify({ services: { gmail: true }, list: [FIXTURE_GMAIL] }) : '{"services":{},"list":[]}');
    if (url.pathname === '/api/tools/run' && req.method === 'POST' && allProviders) {
      const parts = []; for await (const p of req) parts.push(p);
      let b = {}; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      if (b.name !== 'gmail_search') { res.statusCode = 400; return res.end('{"error":"Unknown fixture tool."}'); }
      return res.end(JSON.stringify({ ok: true, result: { messages: [{ from: 'Fixture Sender', subject: 'Local fixture — no Gmail was read', snippet: 'Two unread messages, both made up.' }] } }));
    }
    if (url.pathname === '/api/relay/status') return res.end('{"online":false}');
    // Gemini Omni stub (src/omni.js routes): start → two "in_progress" polls → completed; the video is a placeholder.
    if (url.pathname === '/api/omni/start' && req.method === 'POST') {
      const parts = []; for await (const p of req) parts.push(p);
      let b = {}; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      let row = null;
      if (identity.role === 'owner') { // the owner's spending limits (testers have their own allowance)
        let shaped; try { shaped = shapeOmni(b); } catch (err) { res.statusCode = err.status || 400; return res.end(JSON.stringify({ error: err.message, code: err.code })); }
        row = spendStart('omni', 'video', omniOwnerQuote(shaped));
        if (row instanceof Spend.SpendError) return refuse(res, row);
      }
      const id = `v1_review${Date.now().toString(36)}`; omniJobs.set(id, 0);
      if (row) omniRows.set(id, row);
      return res.end(JSON.stringify({ id, status: 'queued', seconds: b.seconds ?? 6, pollAfterMs: 10000 }));
    }
    const omniM = url.pathname.match(/^\/api\/omni\/(status|video|cancel)\/([A-Za-z0-9_-]+)$/);
    if (omniM) {
      const [, what, id] = omniM;
      if (!omniJobs.has(id)) { res.statusCode = 404; return res.end('{"error":"Google no longer has that video.","code":"omni_gone"}'); }
      if (what === 'cancel') { omniJobs.delete(id); return res.end('{"ok":true}'); }
      if (what === 'status') { const n = omniJobs.get(id) + 1; omniJobs.set(id, n); const done = n > 2; const row = omniRows.get(id); if (done && row && row.actual == null) row.actual = row.amount; return res.end(JSON.stringify({ id, status: done ? 'completed' : 'in_progress', done, video: done, ...(done ? {} : { pollAfterMs: 10000 }) })); }
      res.setHeader('Content-Type', 'video/mp4'); return res.end(await readFile(resolve(root, 'icons/atelier-v2-512.png')));
    }
    // xAI stubs (src/xai.js routes): a Grok Imagine video is "pending" for two polls, then done; the file is a placeholder.
    if (url.pathname === '/api/xai/video/start' && req.method === 'POST') {
      const parts = []; for await (const p of req) parts.push(p);
      let b = {}; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      const row = spendStart('xai', 'video', videoQuoteMicros(b.model, b.seconds ?? 6));
      if (row instanceof Spend.SpendError) return refuse(res, row);
      row.actual = row.amount;
      const id = `review-${Date.now().toString(36)}`; xaiJobs.set(id, 0);
      return res.end(JSON.stringify({ id, model: b.model, seconds: b.seconds ?? 6, resolution: b.resolution ?? '720p', quote: 0.12, pollAfterMs: 5000 }));
    }
    const xaiM = url.pathname.match(/^\/api\/xai\/video\/(status|file)\/([A-Za-z0-9_-]+)$/);
    if (xaiM) {
      const [, what, id] = xaiM;
      if (!xaiJobs.has(id)) { res.statusCode = 404; return res.end('{"error":"xAI no longer has that.","code":"xai_gone"}'); }
      if (what === 'status') { const n = xaiJobs.get(id) + 1; xaiJobs.set(id, n); const done = n > 2; return res.end(JSON.stringify({ id, status: done ? 'done' : 'pending', done, video: done, ...(done ? { usd: 0.12 } : { progress: n * 40, pollAfterMs: 5000 }) })); }
      res.setHeader('Content-Type', 'video/mp4'); return res.end(await readFile(resolve(root, 'icons/atelier-v2-512.png')));
    }
    if (url.pathname === '/api/xai/image' && req.method === 'POST') {
      const row = spendStart('xai', 'image', 40_000);
      if (row instanceof Spend.SpendError) return refuse(res, row);
      row.actual = row.amount;
    }
    if (url.pathname === '/api/xai/image' && req.method === 'POST') return res.end(JSON.stringify({ data: [{ b64_json: (await readFile(resolve(root, 'icons/atelier-v2-512.png'))).toString('base64'), mime_type: 'image/png' }], usd: 0.04 }));
    // Runway is owner only: a tester session gets what src/tester/router.js answers (it has no runway route), so a client
    // slip that offered Runway to testers fails here as it would in production instead of filming a stub.
    if (url.pathname.startsWith('/api/runway/') && identity.role !== 'owner') { res.statusCode = 403; return res.end('{"error":"That part of Atelier is only for its owner.","code":"owner_only"}'); }
    // Runway stubs (src/runway.js routes): the body goes through the Worker's real shapeRequest (a 400 for anything it
    // refuses), the task is RUNNING for two polls, then SUCCEEDED at the quoted cost; the output is a placeholder.
    // REVIEW_RUNWAY_LOG=1 prints each shaped body (what the Worker would send Runway).
    const rwGen = url.pathname.match(/^\/api\/runway\/generate\/(text_to_video|image_to_video|video_to_video)$/);
    if (rwGen && req.method === 'POST') {
      const parts = []; for await (const p of req) parts.push(p);
      let b = null; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      let shaped;
      try { shaped = runwayShape(rwGen[1], b); } catch (err) { res.statusCode = err.status || 400; return res.end(JSON.stringify({ error: err.message, ...(err.extra || {}) })); }
      if (process.env.REVIEW_RUNWAY_LOG) console.log('runway', rwGen[1], JSON.stringify({ ...shaped.body, ...(shaped.body.promptImage ? { promptImage: `${shaped.body.promptImage.slice(0, 24)}…` } : {}) }));
      const row = spendStart('runway', 'video', runwayOwnerQuote(shaped).credits * 10_000);
      if (row instanceof Spend.SpendError) return refuse(res, row);
      row.actual = row.amount;
      const q = runwayQuote(shaped.model, shaped.seconds, shaped.audio, shaped);
      const id = crypto.randomUUID(); runwayJobs.set(id, { n: 0, q });
      return res.end(JSON.stringify({ id, model: shaped.model, kind: rwGen[1], estimatedCost: q, quote: q, pollAfterMs: 5000 }));
    }
    const rwTask = url.pathname.match(/^\/api\/runway\/(task|output)\/([0-9a-f-]{36})$/);
    if (rwTask) {
      const [, what, id] = rwTask, job = runwayJobs.get(id);
      if (!job) { res.statusCode = 404; return res.end('{"error":"That Runway task is gone — it was cancelled, deleted or has expired.","code":"runway_gone","status":"GONE"}'); }
      if (what === 'task' && req.method === 'DELETE') { job.cancelled = true; return res.end('{"ok":true}'); }
      if (what === 'task') {
        job.n += 1;
        const status = job.cancelled ? 'CANCELLED' : job.n > 2 ? 'SUCCEEDED' : 'RUNNING';
        return res.end(JSON.stringify({ id, status, ...(status === 'RUNNING' ? { progress: job.n * 0.4, pollAfterMs: 5000 } : {}), ...(job.q ? { estimatedCost: job.q } : {}), ...(status === 'SUCCEEDED' && job.q ? { cost: job.q } : {}), outputs: status === 'SUCCEEDED' ? 1 : 0 }));
      }
      res.setHeader('Content-Type', 'video/mp4'); return res.end(await readFile(resolve(root, 'icons/atelier-v2-512.png')));
    }
    if (url.pathname === '/api/runway/account') return res.end('{"creditBalance":1200,"usd":12,"maxMonthlyCreditSpend":null,"models":{}}');
    // Owner image stubs (worker.js handlePassthrough): priced with the Worker's imageQuote and held to the monthly limit;
    // the image is the app icon. --providers reports OpenAI and Gemini as configured, so Image mode offers them.
    const xImg = url.pathname.match(/^\/api\/x\/(openai|gemini|meta)\/(.+)$/);
    if (xImg && req.method === 'POST' && identity.role === 'owner') {
      const parts = []; for await (const p of req) parts.push(p);
      let b = null; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      let q; try { q = Spend.imageQuote(xImg[1], xImg[2], b); } catch (err) { return refuse(res, err); }
      const row = spendStart(xImg[1], 'image', q.amount);
      if (row instanceof Spend.SpendError) return refuse(res, row);
      row.actual = row.amount;
      const png = (await readFile(resolve(root, 'icons/atelier-v2-512.png'))).toString('base64');
      return res.end(JSON.stringify(xImg[1] === 'gemini' ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] } : { data: Array.from({ length: q.n }, () => ({ b64_json: png })) }));
    }
    // Read aloud stub: half a second of silence as WAV (the Gemini voices' format), any voice.
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      const parts = []; for await (const p of req) parts.push(p);
      let b = {}; try { b = JSON.parse(Buffer.concat(parts).toString()); } catch {}
      const data = 24_000, wav = Buffer.alloc(44 + data);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + data, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(data, 40);
      res.setHeader('Content-Type', 'audio/wav'); res.setHeader('x-tts-voice', String(b.voice || 'atelier')); res.setHeader('x-tts-brief', '2');
      return res.end(wav);
    }
    if (url.pathname === '/api/transcribe' && req.method === 'POST') { // dictation stub: REVIEW_STT=ok | busy | down | format | slow | empty
      let n = 0; for await (const p of req) n += p.length;
      const mode = process.env.REVIEW_STT || 'ok';
      await new Promise(r => setTimeout(r, mode === 'slow' ? 15_000 : 700)); // slow: time to try the tap-twice cancel
      if (mode === 'busy') { res.statusCode = 429; res.setHeader('Retry-After', '30'); return res.end('{"error":"Dictation is busy right now. Try again in a moment.","code":"transcribe_busy"}'); }
      if (mode === 'down') { res.statusCode = 502; return res.end('{"error":"Dictation is unavailable right now.","code":"transcribe_unavailable"}'); }
      if (mode === 'format') { res.statusCode = 415; return res.end('{"error":"That recording isn’t in an audio format dictation can read.","code":"unsupported_audio"}'); }
      return res.end(JSON.stringify({ text: mode === 'empty' ? '' : `Local dictation fixture: ${n} bytes received. No provider was called.`, provider: 'openai' }));
    }
    if (url.pathname === '/api/chat') {
      const parts = []; for await (const p of req) parts.push(p);
      const body = JSON.parse(Buffer.concat(parts).toString());
      // --providers: a Claude request with a stop-reason trigger goes through the real Worker adapter (claudeStandIn above).
      if (allProviders && String(body.model || '').startsWith('anthropic:') && CLAUDE_TRIGGER.test(promptOf(body.messages))) {
        const { claudeChat } = await import('../src/anthropic.js');
        return writeResponse(res, await claudeChat(body, 'review-fixture-key'));
      }
      // --providers: the accounts agent (a request offering gmail_search) calls it once for an inbox question, then answers
      // from the fixture result (or says it was declined).
      if (allProviders && Array.isArray(body.tools) && body.tools.some((t) => t?.function?.name === 'gmail_search')) {
        const lastMsg = body.messages?.at(-1) || {};
        const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        res.setHeader('Content-Type', 'text/event-stream');
        if (lastMsg.role === 'user' && /\b(inbox|e-?mails?|gmail|unread)\b/i.test(JSON.stringify(lastMsg.content ?? ''))) {
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: 'gmail_search', arguments: JSON.stringify({ q: 'is:unread newer_than:2d' }) } }] } }] });
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          return res.end('data: [DONE]\n\n');
        }
        const declined = lastMsg.role === 'tool' && /declined/.test(String(lastMsg.content));
        sse({ choices: [{ delta: { content: lastMsg.role !== 'tool' ? 'Local fixture answer from the accounts agent. No provider was called.' : declined ? 'OK — I won’t read your inbox. (Local fixture.)' : 'You have 2 unread messages (local fixture — no Gmail was read).' } }] });
        return res.end('data: [DONE]\n\n');
      }
      const system = body.messages?.find(m => m.role === 'system')?.content || '';
      const slow = /slow stream/i.test(JSON.stringify(body.messages?.at(-1) ?? ''));
      const answer = /single-file web apps/.test(system) ? '```html\n<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review counter</title></head><body style="font:18px system-ui;padding:32px;background:#f3eee3;color:#1b1a16"><h1>Review counter</h1><p>Local fixture. No provider was called.</p><button onclick="this.textContent=Number(this.textContent)+1" style="font:inherit;padding:12px 24px">0</button></body></html>\n```'
        : /Return ONLY JSON/.test(system) ? JSON.stringify({ideas:Array.from({length:6},(_,i)=>({title:`Studio idea ${i+1}`,pitch:'A local fixture card for checking the layout and actions.',first_step:'Try expanding this idea.',tags:['Review','Fixture']}))})
        : /<title>|thread title/i.test(system) ? '<title>Design review</title>' : /<facts>/.test(system) ? '<facts></facts>' : 'This is a **local test response**. No AI provider was called.\n\nNero\'s Golden House (Domus Aurea) sat on the Oppian Hill. Mercury is both a planet and a metal.\n\nLook-up test words: slow river, fail state, busy signal, zzz nothing, plain text.\n\n## A little room to create\n\n- Clear navigation across your studio\n- A comfortable reading width\n- Work saved on this device\n\n```javascript\nconst studio = "Atelier";\n```';
      res.setHeader('Content-Type', 'text/event-stream');
      // Thinking-model failures: "think only" reasons with no answer until the app asks again (its nudge is the last turn);
      // "think forever" never answers; "no credit" fails like DeepSeek's mid-stream Insufficient Balance.
      const all = JSON.stringify(body.messages ?? ''), last = JSON.stringify(body.messages?.at(-1) ?? '');
      const nudged = /wrote no answer/.test(last);
      if (/no credit/i.test(all) && !globalThis.reviewCreditUsed) { globalThis.reviewCreditUsed = true; res.write(`data: ${JSON.stringify({ error: { message: 'Insufficient Balance' } })}\n\n`); return res.end(); }
      if ((/think only/i.test(all) && !nudged) || /think forever/i.test(all)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Planning the files… ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      for (const word of answer.match(/.{1,24}/gs)) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        await new Promise(r => setTimeout(r, slow ? 250 : 40));
      }
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 503; return res.end('{"error":"This integration is not available in the local review fixture."}');
  }
  try {
    const name = url.pathname === '/' ? '/index.html' : ['/privacy', '/tos'].includes(url.pathname) ? `${url.pathname}.html` : url.pathname;
    const file = resolve(root, '.' + decodeURIComponent(name));
    if (!file.startsWith(root + sep)) { res.statusCode = 403; return res.end(); }
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
}).listen((Number(process.env.REVIEW_PORT) || Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7)) || 8791), '127.0.0.1', () => console.log(`Isolated review: http://127.0.0.1:${(Number(process.env.REVIEW_PORT) || Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7)) || 8791)} — passcode: review-only${fixtureTester ? ` — simulated tester: ${fixtureTester}` : ''}`)); // REVIEW_PORT: a second fixture beside :8791
