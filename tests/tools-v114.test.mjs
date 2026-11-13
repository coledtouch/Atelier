import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// v114 review, the server-side account tools (src/tools.js), finding tools #10: drive_read held a whole file in memory
// to keep 20,000 characters of it, and it and gmail_read put the id the model wrote into the API path as it was.
// tools.js imports `cloudflare:workers`; stub it so the module loads in Node (see gmail.test.mjs).
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject {} export const waitUntil = () => {};', shortCircuit: true };
    return next(specifier, context);
  },
});
const { runTool } = await import('../src/tools.js');

const MAIL = 'me@gmail.com';
// One connected Google account with a cached access token, so no token refresh is needed.
const env = () => {
  const m = new Map([['google_accounts', JSON.stringify([{ email: MAIL, refresh: 'r' }])], [`google_access:${MAIL}`, JSON.stringify({ token: 't-me', exp: Date.now() + 3600e3 })]]);
  return { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ATELIER_KV: { get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); } } };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// Google, played: every request is kept, and `answer` says what each address gives back.
function google(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    const r = await answer(String(url));
    if (!r) throw new Error(`unmocked ${url}`);
    return r;
  };
  return calls;
}
// A body of `total` bytes that is made only as it is read, 64 KiB at a time; state says how much was asked for.
function lazyBody(total, byte = 0x61) {
  const state = { made: 0, cancelled: false };
  const body = new ReadableStream({
    pull(c) {
      if (state.made >= total) return c.close();
      const n = Math.min(65536, total - state.made);
      c.enqueue(new Uint8Array(n).fill(byte));
      state.made += n;
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}
const FILE = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const META = `https://www.googleapis.com/drive/v3/files/${FILE}?fields=id,name,mimeType,webViewLink`;
const isMeta = (url) => url.startsWith(META.split('=')[0]);
const meta = (mimeType, name = 'server.log') => json({ id: FILE, name, mimeType, webViewLink: `https://drive.google.com/file/d/${FILE}/view` });

test('drive_read and gmail_read take only an id Google could have given: nothing else reaches the API path', async () => {
  const calls = google(() => null);
  // (what is checked is the text that would go into the path, whatever type the model sent)
  const bad = ['abc/../../../gmail/v1/users/me/profile', '..', '../x', 'a/b', 'a?alt=media', 'a#b', 'a b', 'a%2Fb', 'a.b', 'a\nb', 'ä', '', '   ', null, undefined, 'x'.repeat(201), {}, ['a', 'b'], ['../x']];
  for (const id of bad) {
    assert.deepEqual(await runTool(env(), 'drive_read', { file_id: id }, false), { ok: false, error: 'file_id must be an id from drive_search.' }, `drive_read ${JSON.stringify(id)}`);
    assert.deepEqual(await runTool(env(), 'gmail_read', { id }, false), { ok: false, error: 'id must be an id from gmail_search.' }, `gmail_read ${JSON.stringify(id)}`);
  }
  assert.deepEqual(calls, [], 'nothing reached Google, with the owner’s token or without');
});

test('drive_read and gmail_read: the ids Google gives go into the path as they are', async () => {
  const calls = google((url) => {
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) return meta('application/zip', 'site.zip');
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/')) return json({ id: '18c2f3a4b5d6e7f8', threadId: 'th1', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Permit' }, { name: 'Message-ID', value: '<a@mail.example>' }], body: { data: Buffer.from('Approved.').toString('base64url') } } });
    return null;
  });
  for (const id of [FILE, '0B_abc-DEF', '1'.repeat(200), ` ${FILE} `]) {
    const r = await runTool(env(), 'drive_read', { file_id: id }, false);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.at(-1).url, `https://www.googleapis.com/drive/v3/files/${id.trim()}?fields=id,name,mimeType,webViewLink`);
  }
  const mail = await runTool(env(), 'gmail_read', { id: '18c2f3a4b5d6e7f8', account: MAIL }, false);
  assert.equal(mail.ok, true, JSON.stringify(mail));
  assert.deepEqual([mail.result.subject, mail.result.messageId, mail.result.body], ['Permit', '<a@mail.example>', 'Approved.']);
  assert.equal(calls.at(-1).url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18c2f3a4b5d6e7f8?format=full');
  assert.ok(calls.every((c) => c.auth === 'Bearer t-me'));
});

test('drive_read reads the start of a big file and leaves the rest where it is', async () => {
  const big = lazyBody(64 * 1024 * 1024); // a 64 MB log
  const calls = google((url) => (isMeta(url) ? meta('text/plain') : url === `https://www.googleapis.com/drive/v3/files/${FILE}?alt=media` ? new Response(big.body, { status: 200 }) : null));
  const r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.deepEqual([r.result.name, r.result.type, r.result.link], ['server.log', 'text/plain', `https://drive.google.com/file/d/${FILE}/view`]);
  assert.equal(r.result.content, `${'a'.repeat(20000)}…`, 'the first 20,000 characters, marked as cut');
  assert.ok(big.state.made <= 400_000, `only the start was downloaded (${big.state.made} bytes of 64 MB)`);
  assert.equal(big.state.cancelled, true, 'and the download was stopped');
  assert.deepEqual(calls.map((c) => c.url), [META, `https://www.googleapis.com/drive/v3/files/${FILE}?alt=media`], 'the size is no longer asked for: nothing depends on it');
});

test('drive_read: a small file comes back whole, and a character cut in two at the byte limit never shows', async () => {
  let body = 'Line one\nLine two é € 👍\n';
  google((url) => (isMeta(url) ? meta('text/csv', 'jobs.csv') : new Response(body, { status: 200 })));
  let r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.equal(r.result.content, body);
  // 120,000 bytes of a three-byte character: the limit falls inside one, and the 20,000 kept end well before it
  const euro = String.fromCharCode(0x20ac), broken = String.fromCharCode(0xfffd);
  body = euro.repeat(40000);
  r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.equal(r.result.content, `${euro.repeat(20000)}…`);
  assert.ok(!r.result.content.includes(broken));
  // a file just under the limit in bytes is read to its end
  body = 'é'.repeat(15000);
  r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.equal(r.result.content, body);
  // an empty file
  google((url) => (isMeta(url) ? meta('text/plain', 'empty.txt') : new Response(null, { status: 200 })));
  assert.equal((await runTool(env(), 'drive_read', { file_id: FILE }, false)).result.content, '');
});

test('drive_read: Docs, Sheets and Slides are exported as text and read the same way; other types point to the link; a refusal says so', async () => {
  const sheet = lazyBody(8 * 1024 * 1024, 0x37); // a big sheet as CSV
  let calls = google((url) => (isMeta(url) ? meta('application/vnd.google-apps.spreadsheet', 'Bids 2026') : url === `https://www.googleapis.com/drive/v3/files/${FILE}/export?mimeType=text%2Fcsv` ? new Response(sheet.body, { status: 200 }) : null));
  let r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.result.content, `${'7'.repeat(20000)}…`);
  assert.ok(sheet.state.made <= 400_000 && sheet.state.cancelled);
  calls = google((url) => (isMeta(url) ? meta('application/pdf', 'plans.pdf') : null));
  r = await runTool(env(), 'drive_read', { file_id: FILE }, false);
  assert.deepEqual(r.result, { name: 'plans.pdf', type: 'application/pdf', link: `https://drive.google.com/file/d/${FILE}/view`, note: 'This file type can’t be read as text here — open the link.' });
  assert.equal(calls.length, 1, 'no download for a type that isn’t text');
  google((url) => (isMeta(url) ? meta('application/json', 'export.json') : new Response('no', { status: 403 })));
  assert.deepEqual(await runTool(env(), 'drive_read', { file_id: FILE }, false), { ok: false, error: `Drive (${MAIL}) 403: couldn’t read export.json` });
});
