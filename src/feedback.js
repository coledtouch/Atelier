// Feedback is an explicit user submission. Call only after authenticating the owner or tester and applying the
// tester CSRF check. Never record headers, prompts, thread contents or account details as automatic diagnostics.
export const FEEDBACK_LIMITS = Object.freeze({ message: 4000, screenshot: 350 * 1024, request: 490 * 1024, perPerson: 20, total: 500, inbox: 50, days: 90 });
const PREFIX = 'feedback:v1:';
const KINDS = new Set(['bug', 'confusing', 'suggestion']);
const MODES = new Set(['ask', 'code', 'image', 'video', 'ideas', 'build']);
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const json = (doc, status = 200) => new Response(JSON.stringify(doc), { status, headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} });
const fail = (error, status = 400) => json({ error }, status);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function cleanFeedbackDiagnostics(raw) {
  if (!isObject(raw)) return null;
  const doc = {};
  if (MODES.has(raw.mode)) doc.mode = raw.mode;
  if (typeof raw.version === 'string' && /^v?\d{1,4}$/.test(raw.version)) doc.version = raw.version;
  if (typeof raw.online === 'boolean') doc.online = raw.online;
  if (isObject(raw.viewport)) {
    const { width, height } = raw.viewport;
    if ([width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 10000)) doc.viewport = { width, height };
  }
  return Object.keys(doc).length ? doc : null;
}

export function cleanFeedbackScreenshot(raw) {
  if (!isObject(raw) || !TYPES.has(raw.type) || typeof raw.data !== 'string' || !raw.data.length) return null;
  // Canonical base64 only, with a byte cap before decoding. SVG and arbitrary data URLs never reach the inbox.
  if (raw.data.length > Math.ceil(FEEDBACK_LIMITS.screenshot / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.data)) return null;
  let binary;
  try { binary = atob(raw.data); } catch { return null; }
  if (!binary.length || binary.length > FEEDBACK_LIMITS.screenshot || btoa(binary) !== raw.data) return null;
  const b = (i) => binary.charCodeAt(i);
  const png = binary.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => b(i) === n);
  const jpg = binary.length >= 3 && b(0) === 255 && b(1) === 216 && b(2) === 255;
  const webp = binary.length >= 12 && binary.slice(0, 4) === 'RIFF' && binary.slice(8, 12) === 'WEBP';
  if (!(raw.type === 'image/png' && png || raw.type === 'image/jpeg' && jpg || raw.type === 'image/webp' && webp)) return null;
  return { type: raw.type, data: raw.data };
}

async function readBody(req) {
  if (Number(req.headers.get('content-length')) > FEEDBACK_LIMITS.request) return { tooLarge: true };
  if (!req.body) return { bad: true };
  const reader = req.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FEEDBACK_LIMITS.request) { await reader.cancel(); return { tooLarge: true }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return { doc: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch { return { bad: true }; }
}

async function identityTag(who) {
  if (who.role === 'owner') return 'owner';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(who.sub));
  return `tester-${[...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

// Cleanup is best effort because Cloudflare KV lists are eventually consistent. Every entry also expires after
// 90 days, so a delayed list cannot make submitted screenshots permanent. Keys sort newest first globally.
async function trim(kv, tag) {
  const listed = await kv.list({ prefix: PREFIX, limit: 1000 });
  const names = listed.keys.map((k) => k.name).sort();
  let own = 0;
  const remove = names.filter((name, i) => {
    const overPerson = name.endsWith(`:${tag}`) && ++own > FEEDBACK_LIMITS.perPerson;
    return overPerson || i >= FEEDBACK_LIMITS.total;
  });
  await Promise.all(remove.map((name) => kv.delete(name)));
}

/** POST /api/feedback for authenticated users; GET for the owner only. `who` comes from server authentication. */
export async function handleFeedback(req, env, who = {}) {
  if (!['owner', 'tester'].includes(who.role) || who.role === 'tester' && (typeof who.sub !== 'string' || !who.sub || who.sub.length > 1024)) return fail('Sign in to send feedback.', 401);
  if (req.method === 'GET' && who.role !== 'owner') return fail('Only the owner can view submitted feedback.', 403);
  if (!['GET', 'POST'].includes(req.method)) return json({ error: 'Use GET or POST for feedback.' }, 405);
  const kv = env?.ATELIER_KV;
  if (!kv?.get || !kv?.put || !kv?.list || !kv?.delete) return fail('Feedback is temporarily unavailable. Keep your message and try again shortly.', 503);
  try {
    if (req.method === 'GET') {
      const requestedId = new URL(req.url).searchParams.get('id');
      if (requestedId != null) {
        if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestedId)) return fail('Choose a valid feedback item.');
        const listed = await kv.list({ prefix: PREFIX, limit: 1000 });
        const key = listed.keys.find(({ name }) => name.includes(`:${requestedId}:`))?.name;
        if (!key) return fail('This feedback item is no longer available.', 404);
        let stored;
        try { stored = JSON.parse(await kv.get(key)); } catch { return fail('This feedback item is no longer available.', 404); }
        const screenshot = cleanFeedbackScreenshot(stored?.screenshot);
        if (!screenshot) return fail('This feedback item has no screenshot.', 404);
        return json({ screenshot });
      }
      const listed = await kv.list({ prefix: PREFIX, limit: FEEDBACK_LIMITS.inbox });
      const docs = await Promise.all(listed.keys.map(async ({ name }) => {
        let stored;
        try { stored = JSON.parse(await kv.get(name)); } catch { return null; }
        // Return a whitelist even when an older or corrupt record contains other fields.
        if (!isObject(stored) || !KINDS.has(stored.kind) || typeof stored.message !== 'string' || !Number.isSafeInteger(stored.at)) return null;
        const screenshot = cleanFeedbackScreenshot(stored.screenshot);
        return { id: typeof stored.id === 'string' ? stored.id.slice(0, 64) : '', kind: stored.kind, message: stored.message.slice(0, FEEDBACK_LIMITS.message),
          at: stored.at, role: stored.role === 'owner' ? 'owner' : 'tester', diagnostics: cleanFeedbackDiagnostics(stored.diagnostics),
          screenshot: screenshot ? { type: screenshot.type } : null };
      }));
      return json({ entries: docs.filter(Boolean).sort((a, b) => b.at - a.at), retentionDays: FEEDBACK_LIMITS.days });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') || '')) return fail('Send feedback as JSON.', 415);
    const read = await readBody(req);
    if (read.tooLarge) return fail('Feedback is too large. Use a screenshot under 350 KB.', 413);
    const raw = read.doc;
    if (read.bad || !isObject(raw) || !KINDS.has(raw.kind)) return fail('Choose Bug, Confusing or Suggestion and add your message.');
    if (typeof raw.message !== 'string' || !raw.message.trim()) return fail('Add a message before sending feedback.');
    if (raw.message.length > FEEDBACK_LIMITS.message) return fail('Keep your feedback under 4,000 characters.', 413);
    const screenshot = raw.screenshot == null ? null : cleanFeedbackScreenshot(raw.screenshot);
    if (raw.screenshot != null && !screenshot) return fail('Use a PNG, JPEG or WebP screenshot under 350 KB.');
    const tag = await identityTag(who), at = Date.now(), id = crypto.randomUUID();
    const doc = { id, at, role: who.role, kind: raw.kind, message: raw.message.trim(), diagnostics: cleanFeedbackDiagnostics(raw.diagnostics), screenshot };
    const key = `${PREFIX}${String(9999999999999 - at).padStart(13, '0')}:${id}:${tag}`;
    await kv.put(key, JSON.stringify(doc), { expirationTtl: FEEDBACK_LIMITS.days * 86400 });
    // A cleanup failure must not report a failed submission after the message was saved.
    await trim(kv, tag).catch(() => {});
    return json({ ok: true, id }, 201);
  } catch { return fail('Couldn’t save your feedback. Keep your message and try again.', 503); }
}
