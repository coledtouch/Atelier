// The pure sync core (public/sync-merge.js): wire form, validation, the server's document merges and the client's
// pull/push planners. A small in-memory loop (devices + one server document map) checks the planners together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeMediaUrl, validateBackup } from '../public/data-safety.js';
import {
  FORMAT, LIMITS, TRANSIENT, MEDIA_RE, MEDIA_SYNC, INLINE_MAX, canonical, sha256hex, entryHash, strip, dehydrate, hydrate, validateDehydrated,
  checkPush, checkDelete, checkView, applyPush, applyDelete, applyRestore, docView, newRefs, planPull, planPush, planPushResult, pushBodies,
  applyPlan, forkEntry, betterFileRef, quickPrint, utf8Length, newRecord, mediaKinds, gateHeld, refsOf, syncId, docMeta, sortEntries,
  fullPrint, snapOf, sameSnap, validFileRef, MEDIA_HELD, STICKY,
} from '../public/sync-merge.js';
import { validVideo } from '../public/video.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const b64 = (s) => Buffer.from(s).toString('base64');
const PNG = `data:image/png;base64,${b64('png-bytes-1')}`, JPG = `data:image/jpeg;base64,${b64('jpeg-bytes')}`, WEBP = `data:image/webp;base64,${b64('webp')}`;
const MP4 = `data:video/mp4;base64,${b64('mp4-bytes')}`;
const ask = (id, createdAt, text = `answer ${id}`, extra = {}) => ({ id, kind: 'ask', prompt: `prompt ${id}`, createdAt, text, ...extra });
const thread = (id, entries, extra = {}) => ({ id, title: `Thread ${id}`, createdAt: entries[0]?.createdAt ?? 1, updatedAt: 1, entries, ...extra });
let forks = 0;
const uid = () => `fork-${String(++forks).padStart(4, '0')}`;
const file = (name, expiresAt) => ({ name: `files/${name}`, uri: `https://generativelanguage.googleapis.com/v1beta/files/${name}`, mime: 'video/mp4', expiresAt });
const video = (f) => ({ name: 'clip.mp4', mime: 'video/mp4', size: 10, duration: 2, poster: null, frames: [], ...(f ? { file: f } : {}) });

// Server-side document for a list of local entries (each pushed as new), plus later pushes against it.
async function bodyOf(entries, { createdAt = 1, title, bases = {} } = {}) {
  const out = [];
  for (const e of entries) { const x = await dehydrate(e); out.push({ id: e.id, base: bases[e.id] ?? 0, createdAt: e.createdAt, h: x.h, d: x.d }); }
  return { v: FORMAT, createdAt, ...(title ? { title } : {}), entries: out };
}
async function docOf(id, entries, opts) { return applyPush(null, await bodyOf(entries, opts), NOW, id).doc; }
// Record as a device that synced exactly these entries at the doc's revisions would hold it.
async function recordFor(doc) {
  const rec = { ...newRecord(), etag: `e${doc.rev}`, rev: doc.rev, title: doc.title, titleRev: doc.titleRev, e: {} };
  for (const e of doc.entries) rec.e[e.id] = { r: e.rev, f: e.h, g: await gOf(e.d), old: [] };
  return rec;
}
const gOf = async (d) => (d?.video && 'file' in d.video ? sha256hex(canonical({ ...d, video: Object.fromEntries(Object.entries(d.video).filter(([k]) => k !== 'file')) })) : entryHash(d));
const viewOf = (doc, since = null) => docView(doc, `e${doc.rev}`, since);
const blobsOf = async (...entries) => { const m = new Map(); for (const e of entries) for (const b of (await dehydrate(e)).blobs) m.set(b.hash, b.bytes()); return m; };
async function hydrateAll(plan, blobs = new Map()) {
  const out = new Map();
  for (const s of plan.slots) if (s.from === 'remote') out.set(s.id, (await hydrate(s.r.d, (ref) => blobs.get(ref.$b) ?? null)).entry);
  return out;
}

// ── module rules ──
test('sync-merge.js imports nothing (the Worker bundles it; a ?v= relative import would not resolve there)', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../public/sync-merge.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import[\s{*]/m.test(src) && !/\b(?:from|import)\s*\(?\s*['"]\.{1,2}\//.test(src));
  assert.ok(!/\b(window|document|localStorage|indexedDB|navigator)\b/.test(src.replace(/\/\/.*$/gm, '')), 'DOM-free');
});

// ── canonical + hashing ──
test('canonical JSON is stable across key order and matches what JSON transport preserves', async () => {
  const a = { b: 1, a: [3, { y: 'x', x: null }], c: { e: true, d: 'é' } };
  const b = { c: { d: 'é', e: true }, a: [3, { x: null, y: 'x' }], b: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(canonical(a), '{"a":[3,{"x":null,"y":"x"}],"b":1,"c":{"d":"é","e":true}}');
  assert.equal(canonical({ u: undefined, f: () => 1, n: NaN, arr: [undefined, Infinity], neg: -0 }), '{"arr":[null,null],"n":null,"neg":0}');
  const lone = { s: 'a\ud800b' };
  assert.equal(await entryHash(JSON.parse(JSON.stringify(lone))), await entryHash(lone), 'a lone surrogate survives JSON transport');
  assert.equal(await sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256hex(new Uint8Array([0x61, 0x62, 0x63])), await sha256hex('abc'));
  assert.equal(utf8Length('aé€😀\ud800'), 1 + 2 + 3 + 4 + 3);
});

test('MEDIA_RE accepts exactly what data-safety safeMediaUrl accepts for data: URLs', () => {
  const samples = [
    'data:image/png;base64,YQ==', 'data:image/jpg;base64,YQ==', 'data:image/jpeg;base64,YQ==', 'data:image/webp;base64,YQ==',
    'data:image/gif;base64,YQ==', 'data:image/avif;base64,YQ==', 'data:video/mp4;base64,YQ==', 'data:video/webm;base64,YQ==',
    'DATA:IMAGE/PNG;BASE64,YQ==', 'data:Image/Jpeg;base64,YQ==', 'data:image/png;base64,YQ ==\n', 'data:image/png;base64,YQ\t==',
    'data:image/png;charset=utf-8;base64,YQ==', 'data:image/svg+xml;base64,YQ==', 'data:video/quicktime;base64,YQ==', 'data:image/png,YQ==',
    'data:image/png;base64,', 'data:image/png;base64,YQ==<', 'data:text/plain;base64,YQ==', ' data:image/png;base64,YQ==', 'data:image/pngx;base64,YQ==',
  ];
  for (const s of samples) assert.equal(MEDIA_RE.test(s), safeMediaUrl(s), s);
});

// ── strip / dehydrate / hydrate ──
test('strip drops only the transient keys; expect, cut, steps, canva, forkOf, meta and params sync', () => {
  const e = { ...ask('e1', 1), pending: false, stage: 'x', status: 'y', startedAt: 3, chars: 9, recovered: true,
    expect: 'text', cut: { at: 3 }, steps: [{ status: 'done' }], canva: { id: 'c' }, forkOf: 'e0', meta: { model: 'm' }, params: { a: 1 } };
  const s = strip(e);
  for (const k of TRANSIENT) assert.equal(k in s, false, k);
  for (const k of ['expect', 'cut', 'steps', 'canva', 'forkOf', 'meta', 'params', 'text', 'prompt']) assert.deepEqual(s[k], e[k], k);
  assert.equal(e.pending, false, 'the source entry is untouched');
  assert.notEqual(s.steps, e.steps, 'a deep copy');
});

test('dehydrate → hydrate is byte-exact for every media field and long text, and refs carry hash, type and size', async () => {
  const html = '<!doctype html>' + 'é<b>x</b>'.repeat(11_000); // ~100 KB of UTF-8
  const e = {
    ...ask('e1', 1), kind: 'build', images: [PNG, JPG], media: [{ type: 'image', src: WEBP, still: PNG }, { type: 'video', src: MP4 }],
    video: { ...video(), poster: JPG, frames: [{ t: 0, src: PNG }, { t: 1, src: WEBP }] }, app: { html, title: 'App' }, think: 'short',
  };
  const x = await dehydrate(e);
  assert.equal(x.held, null);
  assert.deepEqual([...x.kinds].sort(), ['image', 'video']);
  assert.equal(x.d.app.html.t, 'text');
  assert.equal(x.d.app.html.n, Buffer.byteLength(html));
  assert.equal(x.d.app.html.$b, await sha256hex(html));
  assert.deepEqual(x.d.images[0], { $b: await sha256hex(Buffer.from('png-bytes-1')), t: 'image/png', n: 11 });
  assert.equal(x.d.think, 'short', 'short strings stay inline');
  assert.equal(x.blobs.length, 5, 'unique blobs: png, jpeg, webp, mp4 and the html');
  assert.equal(validateDehydrated(x.d), null);
  assert.equal(x.h, await entryHash(x.d));
  const store = new Map(x.blobs.map((b) => [b.hash, b.bytes()]));
  for (const b of x.blobs) assert.equal(await sha256hex(b.bytes()), b.hash);
  const back = await hydrate(x.d, (ref) => store.get(ref.$b));
  assert.deepEqual(back.missing, []);
  assert.deepEqual(back.entry, e);
  // missing blobs are reported, nothing half-hydrated
  const partial = await hydrate(x.d, (ref) => (ref.t === 'text' ? null : store.get(ref.$b)));
  assert.equal(partial.entry, null);
  assert.deepEqual(partial.missing, [x.d.app.html.$b]);
  // a hydrated entry passes the import validator
  assert.equal(validateBackup({ app: 'atelier', v: 1, threads: [{ ...thread('t', []), entries: [back.entry] }] }).length, 1);
});

test('the same bytes give the same ref whatever the base64 whitespace; the memo skips re-hashing media, never text', async () => {
  const spaced = `data:image/png;base64,${b64('png-bytes-1').replace(/(.{4})/g, '$1\n ')}`;
  const a = await dehydrate({ ...ask('e1', 1), images: [PNG] }), b = await dehydrate({ ...ask('e1', 1), images: [spaced] });
  assert.deepEqual(a.d.images, b.d.images);
  assert.equal(a.h, b.h);
  // the client's memo answers only for the exact string it hashed
  const memo = new Map(), asked = [], hashed = [];
  const m = { get: (path, s) => { asked.push(path); const r = memo.get(path); return r && r.s === s ? r.h : undefined; }, set: (path, s, h) => memo.set(path, { s, h }) };
  const hash = (data) => { hashed.push(typeof data === 'string' ? 'doc' : 'blob'); return sha256hex(data); };
  const e = { ...ask('e1', 1), images: [PNG], text: 'y'.repeat(INLINE_MAX + 1) };
  const first = await dehydrate(e, { memo: m, hash });
  assert.deepEqual(hashed.filter((k) => k === 'blob').length, 2);
  assert.deepEqual(asked, ['/images/0'], 'only the media string is looked up');
  hashed.length = 0;
  const again = await dehydrate(e, { memo: m, hash });
  assert.equal(hashed.filter((k) => k === 'blob').length, 1, 'media from the memo; the long text is hashed again in full');
  assert.deepEqual(again.d, first.d);
  assert.equal(again.h, first.h);
  assert.equal(memo.has('/text'), false, 'long text never goes into the memo');
});

// Review finding (blocker): a same-length edit of a long text that differs outside sampled positions reused the old
// blob, so other devices got the old answer. Nothing samples now.
test('a same-length edit of a long text, differing at index 3, always gets its own blob and a different print', async () => {
  const long = (c) => `abc${c}${'x'.repeat(40_000)}`;
  const A = ask('e1', 1, long('1')), B = ask('e1', 1, long('2'));
  const memo = new Map();
  const m = { get: (path, s) => { const r = memo.get(path); return r && r.s === s ? r.h : undefined; }, set: (path, s, h) => memo.set(path, { s, h }) };
  const a = await dehydrate(A, { memo: m }), b = await dehydrate(B, { memo: m }), fresh = await dehydrate(B);
  assert.notEqual(a.d.text.$b, b.d.text.$b);
  assert.equal(b.d.text.$b, fresh.d.text.$b, 'the memoized dehydrate gives the true hash');
  assert.equal(b.d.text.$b, await sha256hex(long('2')));
  assert.notEqual(fullPrint(long('1')), fullPrint(long('2')));
  assert.notEqual(quickPrint(A), quickPrint(B), 'quickPrint covers every character');
  assert.equal(quickPrint(structuredClone(B)), quickPrint(B));
  // the planners' snapshot: exact (===) on long strings, equal for an identical copy
  const s = snapOf(A);
  assert.equal(sameSnap(A, s), true);
  assert.equal(sameSnap(structuredClone(A), s), true, 'an identical copy re-read from IndexedDB matches');
  assert.equal(sameSnap(B, s), false);
  A.text = long('2');
  assert.equal(sameSnap(A, s), false, 'an in-place same-length edit is noticed');
});

test('lone surrogates stay inline; a literal $b key or a 2 MiB+ entry is held; bad base64 is held', async () => {
  const lone = 'x'.repeat(INLINE_MAX + 10) + '\ud800';
  const x = await dehydrate({ ...ask('e1', 1), text: lone });
  assert.equal(x.held, null);
  assert.equal(x.d.text, lone, 'not a text blob: UTF-8 would change it');
  assert.equal(validateDehydrated(x.d), null);
  assert.equal((await dehydrate({ ...ask('e1', 1), params: { $b: 'x' } })).held, 'ref_key');
  assert.equal((await dehydrate({ ...ask('e1', 1), params: { deep: [{ $b: 1 }] } })).held, 'ref_key');
  const big = { ...ask('e1', 1), params: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, 'z'.repeat(INLINE_MAX - 1)])) };
  const held = await dehydrate(big);
  assert.equal(held.held, 'too_large');
  assert.ok(held.size > LIMITS.entry);
  assert.equal((await dehydrate({ ...ask('e1', 1), images: ['data:image/png;base64,ab=c'] })).held, 'bad_media');
  const tiny = await dehydrate({ ...ask('e1', 1), images: ['data:image/png;base64,YQ=='] });
  assert.deepEqual(tiny.d.images, [{ $b: await sha256hex('a'), t: 'image/png', n: 1 }], 'even a one-byte image becomes a ref');
  assert.equal(validateDehydrated({ ...ask('e1', 1), images: ['data:image/png;base64,YQ=='] }), 'inline_media');
});

test('the phase gate: images and videos sync now (phase 3); a gate that is closed holds media entries without decoding them', () => {
  assert.deepEqual(MEDIA_SYNC, { image: true, video: true });
  assert.equal(gateHeld(mediaKinds({ ...ask('e', 1), images: [PNG] })), null);
  assert.equal(gateHeld(mediaKinds({ ...ask('e', 1), images: [PNG] }), { image: false, video: false }), 'media');
  assert.equal(gateHeld(mediaKinds({ ...ask('e', 1), media: [{ type: 'video', src: MP4 }] }), { image: true, video: false }), 'media');
  assert.equal(gateHeld(mediaKinds({ ...ask('e', 1), media: [{ type: 'video', src: MP4 }] }), { image: true, video: true }), null);
  assert.equal(gateHeld(mediaKinds({ ...ask('e', 1), media: [{ type: 'image', src: 'https://example.com/a.png' }] })), null);
  assert.equal(gateHeld(mediaKinds(ask('e', 1))), null);
});

// ── validation ──
test('validateDehydrated rejects what the server must never store', async () => {
  const ok = (await dehydrate({ ...ask('e1', 1), app: { html: 'h'.repeat(INLINE_MAX + 1), title: 'A' } })).d;
  assert.equal(validateDehydrated(ok), null);
  const ref = ok.app.html;
  const deep = (n) => { let v = 'leaf'; for (let i = 0; i < n; i++) v = { v }; return v; };
  const cases = {
    proto_key: { ...ask('e1', 1), params: JSON.parse('{"__proto__":{"x":1}}') },
    proto_key_constructor: { ...ask('e1', 1), meta: { constructor: 1 } },
    too_deep: { ...ask('e1', 1), params: deep(39) },
    inline_media: { ...ask('e1', 1), images: [PNG] },
    long_string: { ...ask('e1', 1), text: 'y'.repeat(INLINE_MAX + 1) },
    bad_ref_63: { ...ask('e1', 1), app: { html: { ...ref, $b: ref.$b.slice(1) }, title: 'A' } },
    bad_ref_65: { ...ask('e1', 1), app: { html: { ...ref, $b: `${ref.$b}0` }, title: 'A' } },
    bad_ref_upper: { ...ask('e1', 1), app: { html: { ...ref, $b: ref.$b.toUpperCase() }, title: 'A' } },
    bad_ref_type: { ...ask('e1', 1), app: { html: { ...ref, t: 'image/svg+xml' }, title: 'A' } },
    bad_ref_extra: { ...ask('e1', 1), app: { html: { ...ref, x: 1 }, title: 'A' } },
    bad_ref_size: { ...ask('e1', 1), app: { html: { ...ref, n: -1 }, title: 'A' } },
    pending: { ...ask('e1', 1), pending: true },
    live_steps: { ...ask('e1', 1), steps: [{ status: 'done' }, { status: 'awaiting' }] },
    live_steps_running: { ...ask('e1', 1), steps: [{ status: 'running' }] },
    transient: { ...ask('e1', 1), stage: 'Thinking' },
    bad_shape: { ...ask('e1', 1), id: '../x' },
  };
  for (const [name, d] of Object.entries(cases)) assert.equal(validateDehydrated(d), name.replace(/_(63|65|upper|type|extra|size|constructor|running)$/, ''), name);
  assert.equal(validateDehydrated({ ...ask('e1', 1), params: deep(37) }), null, 'just under the depth limit');
  assert.equal(validateDehydrated({ ...ask('e1', 1), images: ['https://example.com/a.png'] }), null);
  assert.equal(validateDehydrated({ ...ask('e1', 1), steps: [{ status: 'done' }], app: { html: ref, title: 'A' } }), null);
});

test('checkPush / checkDelete / checkView shape rules', async () => {
  const body = await bodyOf([ask('e1', 1)]);
  assert.equal(checkPush(body), null);
  for (const bad of [null, {}, { ...body, v: 2 }, { ...body, createdAt: -1 }, { ...body, entries: {} }, { ...body, title: { v: 5, base: 0 } },
    { ...body, title: { v: 'x'.repeat(LIMITS.title + 1), base: 0 } }, { ...body, entries: Array.from({ length: 201 }, () => body.entries[0]) },
    { ...body, entries: [{ ...body.entries[0], h: 'ABC' }] }, { ...body, entries: [{ ...body.entries[0], base: -1 }] }]) assert.equal(checkPush(bad)?.code, 'bad_shape');
  assert.equal(checkPush({ ...body, entries: [body.entries[0], body.entries[0]] })?.code, 'bad_id');
  assert.equal(checkPush({ ...body, entries: [{ ...body.entries[0], d: { ...body.entries[0].d, id: 'other' } }] })?.code, 'bad_id');
  assert.equal(checkPush({ ...body, entries: [{ ...body.entries[0], id: '__proto__', d: { ...body.entries[0].d, id: '__proto__' } }] })?.code, 'bad_id');
  assert.deepEqual(checkPush({ ...body, entries: [{ ...body.entries[0], d: { ...body.entries[0].d, pending: true } }] }), { status: 422, code: 'pending', id: 'e1' });
  assert.equal(checkPush({ ...body, entries: [{ ...body.entries[0], d: { ...body.entries[0].d, steps: [{ status: 'running' }] } }] })?.status, 422);
  assert.equal(checkDelete({ v: 1, seen: { e1: 1 } }), null);
  for (const bad of [{}, { v: 1 }, { v: 1, seen: { e1: -1 } }, { v: 1, seen: { 'a/b': 1 } }, { v: 1, seen: [] }]) assert.equal(checkDelete(bad)?.code, 'bad_shape');
  const doc = await docOf('t1', [ask('e1', 1)]);
  assert.equal(checkView(viewOf(doc), 't1'), null);
  assert.equal(checkView(viewOf(doc), 't2'), 'bad_shape');
  assert.equal(checkView({ ...viewOf(doc), v: 2 }, 't1'), 'upgrade');
  assert.equal(checkView({ ...viewOf(doc), entries: [{ ...viewOf(doc).entries[0], h: 'x' }] }, 't1'), 'bad_shape');
});

// ── server merges ──
test('applyPush: create, fast-forward, idempotent resend, stale, conflict and dropped', async () => {
  const e1 = ask('e1', 10), e2 = ask('e2', 20);
  const created = applyPush(null, await bodyOf([e2, e1], { title: { v: 'Hello', base: 0 }, createdAt: 10 }), NOW, 't1');
  assert.equal(created.changed, true);
  const doc = created.doc;
  assert.deepEqual(created.response.accepted, { e1: 1, e2: 1 });
  assert.equal(created.response.prevRev, 0);
  assert.equal(doc.rev, 1);
  assert.deepEqual(doc.entries.map((e) => [e.id, e.rev, e.s]), [['e1', 1, 1], ['e2', 1, 1]], 'sorted by (createdAt, id)');
  assert.deepEqual(created.response.title, { v: 'Hello', rev: 1 });
  // the same body again: nothing changes, same revisions
  const again = applyPush(doc, await bodyOf([e2, e1], { title: { v: 'Hello', base: 0 }, createdAt: 10 }), NOW + 1);
  assert.equal(again.changed, false);
  assert.deepEqual(again.response.accepted, { e1: 1, e2: 1 });
  assert.equal(again.doc, doc);
  // fast-forward from base 1
  const e1b = { ...e1, text: 'edited' };
  const ff = applyPush(doc, await bodyOf([e1b], { bases: { e1: 1 }, createdAt: 10 }), NOW + 2);
  assert.deepEqual(ff.response.accepted, { e1: 2 });
  const d2 = ff.doc;
  assert.equal(d2.rev, 2);
  const s1 = d2.entries.find((e) => e.id === 'e1');
  assert.deepEqual([s1.rev, s1.s, s1.hh.length], [2, 2, 1]);
  assert.equal(d2.entries.find((e) => e.id === 'e2').s, 1);
  assert.equal(doc.entries[0].rev, 1, 'the input document is not mutated');
  // a stale tab re-sends the old copy at base 1: its h is in hh → stale, the server copy comes back
  const stale = applyPush(d2, await bodyOf([e1], { bases: { e1: 1 }, createdAt: 10 }), NOW + 3);
  assert.equal(stale.changed, false);
  assert.deepEqual(stale.response.stale.map((v) => [v.id, v.rev, v.h]), [['e1', 2, s1.h]]);
  // a different edit at base 1 → conflict, server keeps its version
  const conflict = applyPush(d2, await bodyOf([{ ...e1, text: 'other' }], { bases: { e1: 1 }, createdAt: 10 }), NOW + 4);
  assert.equal(conflict.changed, false);
  assert.deepEqual(conflict.response.conflicts.map((v) => [v.id, v.rev, v.d.text]), [['e1', 2, 'edited']]);
  assert.equal('hh' in conflict.response.conflicts[0], false);
  // gone → dropped
  const del = applyDelete(d2, { e2: 1 }, NOW + 5).doc;
  const dropped = applyPush(del, await bodyOf([{ ...e2, text: 'late edit' }], { bases: { e2: 1 }, createdAt: 10 }), NOW + 6);
  assert.deepEqual(dropped.response.dropped, ['e2']);
  assert.equal(dropped.changed, false);
});

test('applyPush: a new entry revives a tombstone; title base rules; createdAt minimum; caps', async () => {
  const doc = await docOf('t1', [ask('e1', 10)], { title: { v: 'Hello', base: 0 }, createdAt: 10 });
  const tomb = applyDelete(doc, { e1: 1 }, NOW + 1).doc;
  assert.ok(tomb.deletedAt);
  assert.equal(tomb.title, '');
  const titleOnly = applyPush(tomb, { v: 1, createdAt: 10, title: { v: 'Ghost', base: tomb.titleRev }, entries: [] }, NOW + 2);
  assert.equal(titleOnly.changed, false, 'a tombstone takes no title on its own');
  const revived = applyPush(tomb, await bodyOf([ask('e9', 30)], { title: { v: 'Back', base: 0 }, createdAt: 10 }), NOW + 3);
  assert.equal(revived.response.revived, true);
  assert.equal(revived.doc.deletedAt, null);
  assert.equal(revived.doc.title, 'Back', 'an empty title takes any proposal');
  // title: base must match, otherwise the server's stands
  const t1 = applyPush(doc, { v: 1, createdAt: 10, title: { v: 'Renamed', base: 1 }, entries: [] }, NOW);
  assert.deepEqual(t1.response.title, { v: 'Renamed', rev: 2 });
  const t2 = applyPush(t1.doc, { v: 1, createdAt: 10, title: { v: 'Mine', base: 1 }, entries: [] }, NOW);
  assert.equal(t2.changed, false);
  assert.deepEqual(t2.response.title, { v: 'Renamed', rev: 2 });
  // createdAt: the minimum of the two
  const older = applyPush(doc, { v: 1, createdAt: 5, entries: [] }, NOW);
  assert.equal(older.doc.createdAt, 5);
  assert.equal(applyPush(doc, { v: 1, createdAt: 50, entries: [] }, NOW).changed, false);
  // entry cap
  const many = { ...doc, entries: Array.from({ length: LIMITS.docEntries }, (_, i) => ({ id: `x${i}`, rev: 1, s: 1, h: '0'.repeat(64), hh: [], createdAt: i, d: { id: `x${i}` } })) };
  assert.equal(applyPush(many, await bodyOf([ask('one-more', 1)]), NOW).error, 'too_large');
  // size cap
  const fat = (i) => ({ ...ask(`f${i}`, i), params: Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`k${j}`, 'z'.repeat(32_000)])) });
  let cur = null;
  for (let i = 0; i < 4; i++) cur = applyPush(cur, await bodyOf([fat(i)]), NOW, 'fat').doc;
  assert.equal(applyPush(cur, await bodyOf([fat(9)]), NOW).error, 'too_large');
});

test('newRefs lists only blob hashes the document did not reference before', async () => {
  const html = 'h'.repeat(INLINE_MAX + 5);
  const a = { ...ask('e1', 1), app: { html, title: 'A' } };
  const doc = await docOf('t1', [a]);
  const ref = (await dehydrate(a)).d.app.html.$b;
  const fresh = applyPush(null, await bodyOf([a]), NOW, 't1');
  assert.deepEqual(newRefs(null, fresh.doc, fresh.changedIds), [ref]);
  const b = { ...ask('e2', 2), app: { html, title: 'Same text' }, think: 't'.repeat(INLINE_MAX + 1) };
  const more = applyPush(doc, await bodyOf([b]), NOW);
  assert.deepEqual(newRefs(doc, more.doc, more.changedIds), [(await dehydrate(b)).d.think.$b]);
  assert.deepEqual([...refsOf(more.doc.entries[1].d)].sort(), [ref, (await dehydrate(b)).d.think.$b].sort());
});

test('applyDelete is rev-aware, tombstones an emptied thread and is a no-op when repeated', async () => {
  let doc = await docOf('t1', [ask('e1', 1), ask('e2', 2), ask('e3', 3)], { title: { v: 'Hello', base: 0 } });
  doc = applyPush(doc, await bodyOf([{ ...ask('e2', 2), text: 'changed elsewhere' }], { bases: { e2: 1 } }), NOW).doc; // e2 → rev 2
  const out = applyDelete(doc, { e1: 1, e2: 1 }, NOW + 1); // the deleter saw e2 at rev 1 and never saw e3
  assert.deepEqual(out.removed, ['e1']);
  assert.deepEqual(out.kept, ['e2', 'e3']);
  assert.equal(out.deleted, false);
  assert.deepEqual(out.doc.gone, { e1: 1 });
  assert.equal(out.doc.title, 'Hello');
  const all = applyDelete(out.doc, { e2: 2, e3: 1 }, NOW + 2);
  assert.equal(all.deleted, true);
  assert.equal(all.doc.deletedAt, NOW + 2);
  assert.equal(all.doc.title, '');
  assert.deepEqual(all.doc.entries, []);
  assert.deepEqual(all.doc.gone, { e1: 1, e2: 2, e3: 1 });
  const repeat = applyDelete(all.doc, { e2: 2, e3: 1 }, NOW + 3);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.doc, all.doc);
});

test('applyRestore brings back absent entries with a bumped rev, out of gone, and clears deletedAt', async () => {
  const doc = await docOf('t1', [ask('e1', 1), ask('e2', 2)], { title: { v: 'Hello', base: 0 } });
  const tomb = applyDelete(doc, { e1: 1, e2: 1 }, NOW + 1).doc;
  const r = applyRestore(tomb, doc, NOW + 2);
  assert.equal(r.changed, true);
  assert.deepEqual(r.restored, ['e1', 'e2']);
  assert.equal(r.doc.deletedAt, null);
  assert.equal(r.doc.title, 'Hello');
  assert.deepEqual(r.doc.gone, {});
  assert.deepEqual(r.doc.entries.map((e) => [e.id, e.rev, e.s]), [['e1', 2, tomb.rev + 1], ['e2', 2, tomb.rev + 1]]);
  assert.equal(applyRestore(r.doc, doc, NOW + 3).changed, false, 'nothing absent: nothing to do');
});

test('docView: since returns entries with s > since; gone is always complete; since 0 or beyond rev is full', async () => {
  let doc = await docOf('t1', [ask('e1', 1), ask('e2', 2)]);
  doc = applyPush(doc, await bodyOf([{ ...ask('e2', 2), text: 'v2' }], { bases: { e2: 1 } }), NOW).doc;
  doc = applyDelete(doc, { e1: 1 }, NOW).doc;
  const v = docView(doc, 'etag', 1);
  assert.equal(v.full, false);
  assert.deepEqual(v.entries.map((e) => e.id), ['e2']);
  assert.deepEqual(v.gone, { e1: 1 });
  assert.equal(docView(doc, 'etag', 0).full, true);
  assert.equal(docView(doc, 'etag', 99).full, true);
  assert.deepEqual(docMeta(doc, 5), { v: '1', rev: '3', at: String(NOW), del: '0', n: '1', snap: '5', born: String(NOW) });
  assert.equal(docView(doc, 'etag').born, NOW, 'the lineage travels with every view');
});

// ── planPull ──
test('planPull adopts the server copy when the local one is unchanged since the record, or is a stale write-back', async () => {
  const e1 = ask('e1', 1);
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'from the phone' }], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [structuredClone(e1)]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2, rec.rev), uid });
  assert.equal(plan.defer, null);
  assert.deepEqual(plan.slots.map((s) => [s.id, s.from]), [['e1', 'remote']]);
  assert.equal(plan.record.e.e1.r, 2);
  assert.deepEqual(plan.record.e.e1.old, [rec.e.e1.f]);
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.equal(r.ok, true);
  assert.equal(local.entries[0].text, 'from the phone');
  // later a stale tab writes back the first copy: its hash is in old → adopt the server copy again, no fork
  const staleLocal = thread('t1', [structuredClone(e1)]);
  const again = await planPull({ local: staleLocal, record: r.record, remote: viewOf(doc2), uid });
  assert.deepEqual(again.slots.map((s) => [s.id, s.from]), [['e1', 'remote']]);
  assert.deepEqual(again.forks, []);
});

test('planPull: a recovered entry adopts the server answer, forking only partial work that differs', async () => {
  const good = ask('e1', 1, 'the finished answer');
  const doc = await docOf('t1', [good]);
  const rec = await recordFor(doc);
  // interrupted retry with partial text
  const partial = thread('t1', [{ ...good, text: 'half an ans', recovered: true, error: 'interrupted' }], { title: '' });
  const plan = await planPull({ local: partial, record: rec, remote: viewOf(doc), uid });
  assert.deepEqual(plan.slots.map((s) => s.from), ['remote', 'fork']);
  const fork = plan.slots[1].entry;
  assert.ok(syncId(fork.id));
  assert.equal(fork.forkOf, 'e1');
  assert.equal(fork.recovered, true, 'the note says it came from an interrupted retry');
  assert.equal(fork.createdAt, 1);
  assert.equal(plan.push, true);
  const r = applyPlan(partial, plan, await hydrateAll(plan));
  assert.deepEqual(partial.entries.map((e) => [e.id, e.text]), [['e1', 'the finished answer'], [fork.id, 'half an ans']]);
  assert.equal('recovered' in partial.entries[0], false, 'the adopted answer is no longer marked recovered');
  assert.equal(r.ok, true);
  // interrupted before producing anything: adopt, no fork
  const empty = thread('t1', [{ ...good, text: '', recovered: true, error: 'interrupted' }], { title: '' });
  const plan2 = await planPull({ local: empty, record: rec, remote: viewOf(doc), uid });
  assert.deepEqual(plan2.slots.map((s) => s.from), ['remote']);
  assert.equal(plan2.push, false);
});

test('planPull: a real concurrent edit forks the local version right after the original', async () => {
  const e1 = ask('e1', 1), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'phone edit' }], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [{ ...e1, text: 'pc edit' }, e2]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2, rec.rev), uid });
  assert.deepEqual(plan.slots.map((s) => s.from), ['remote', 'fork', 'local']);
  const fork = plan.slots[1].entry;
  assert.ok(/^[\w-]{1,120}$/.test(fork.id));
  assert.equal(fork.forkOf, 'e1');
  assert.equal(fork.text, 'pc edit');
  assert.equal(plan.record.e.e1.r, 2);
  assert.equal(plan.record.e[fork.id], undefined, 'the fork pushes as a new entry (base 0)');
  applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(local.entries.map((e) => [e.id, e.text]), [['e1', 'phone edit'], [fork.id, 'pc edit'], ['e2', 'answer e2']]);
  const push = await planPush({ thread: local, record: plan.record });
  assert.deepEqual(push.entries.map((e) => [e.id, e.base]), [[fork.id, 0]]);
});

test('planPull: video.file-only differences never fork (cases i–iii)', async () => {
  const soon = NOW + 10 * MIN, later = NOW + 40 * 3600e3, latest = NOW + 47 * 3600e3;
  const base = { ...ask('v1', 1), kind: 'video', video: video(file('a', later)) };
  const doc = await docOf('t1', [base]);
  const rec = await recordFor(doc);
  // i: same content, only the FileRef differs → server copy with the better ref, pushed back
  const doc2 = applyPush(doc, await bodyOf([{ ...base, video: video(file('b', soon)) }], { bases: { v1: 1 } }), NOW).doc;
  const localI = thread('t1', [{ ...base, video: video(file('c', latest)) }]);
  const i = await planPull({ local: localI, record: rec, remote: viewOf(doc2), uid, now: NOW });
  assert.deepEqual(i.slots.map((s) => s.from), ['remote']);
  assert.equal(i.slots[0].file.name, 'files/c');
  assert.equal(i.push, true);
  // ii: the server changed only the FileRef since the record, the local text changed → keep local, rebased
  const localII = thread('t1', [{ ...base, text: 'local edit' }]);
  const ii = await planPull({ local: localII, record: rec, remote: viewOf(doc2), uid, now: NOW });
  assert.deepEqual(ii.slots.map((s) => s.from), ['local']);
  assert.equal(ii.slots[0].file, undefined, 'the local ref (later expiry) is already the better one');
  assert.equal(ii.record.e.v1.r, 2, 'the push goes with base = the server rev');
  assert.equal(ii.push, true);
  // iii: only the local FileRef changed since the record, the server changed the text → adopt server, keep better ref
  const doc3 = applyPush(doc, await bodyOf([{ ...base, text: 'server text' }], { bases: { v1: 1 } }), NOW).doc;
  const localIII = thread('t1', [{ ...base, video: video(file('d', latest)) }]);
  const iii = await planPull({ local: localIII, record: rec, remote: viewOf(doc3), uid, now: NOW });
  assert.deepEqual(iii.slots.map((s) => s.from), ['remote']);
  assert.equal(iii.slots[0].file.name, 'files/d');
  for (const p of [i, ii, iii]) assert.deepEqual(p.forks, []);
  applyPlan(localIII, iii, await hydrateAll(iii));
  assert.equal(localIII.entries[0].text, 'server text');
  assert.equal(localIII.entries[0].video.file.name, 'files/d');
});

test('betterFileRef takes the later expiry, and nothing when that has under 15 minutes left', () => {
  const a = file('a', NOW + 60 * MIN), b = file('b', NOW + 120 * MIN);
  assert.equal(betterFileRef(a, b, NOW), b);
  assert.equal(betterFileRef(b, a, NOW), b);
  assert.equal(betterFileRef(null, a, NOW), a);
  assert.equal(betterFileRef(file('x', NOW + 14 * MIN), file('y', NOW + 5 * MIN), NOW), null);
  assert.equal(betterFileRef(null, undefined, NOW), null);
});

test('planPull: known-but-missing entries come back; a full pull re-pushes what the server lost and never deletes locally', async () => {
  const e1 = ask('e1', 1), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2]);
  const rec = await recordFor(doc);
  // a stale writer dropped e2 locally
  const local = thread('t1', [structuredClone(e1)]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc), uid });
  assert.deepEqual(plan.slots.map((s) => [s.id, s.from]), [['e1', 'local'], ['e2', 'remote']]);
  applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(local.entries.map((e) => e.id), ['e1', 'e2']);
  // the server lost e2 (a full document without it and without a gone mark)
  const lost = { ...doc, entries: doc.entries.filter((e) => e.id === 'e1') };
  const plan2 = await planPull({ local, record: plan.record, remote: viewOf(lost), uid });
  assert.deepEqual(plan2.slots.map((s) => [s.id, s.from]), [['e1', 'local'], ['e2', 'local']], 'kept locally');
  assert.deepEqual([plan2.record.e.e2.r, plan2.record.e.e2.f], [0, null], 'record reset (its history of older versions kept)');
  assert.equal(plan2.push, true);
  const push = await planPush({ thread: local, record: plan2.record });
  assert.deepEqual(push.entries.map((e) => [e.id, e.base]), [['e2', 0]]);
  // a delta pull (full: false) lacking an entry changes nothing
  const plan3 = await planPull({ local, record: plan.record, remote: viewOf(doc, doc.rev - 1 + 1), uid });
  assert.equal(plan3.changed, false);
});

test('planPull: gone removes unchanged entries and forks real local edits; a tombstone keeps unsynced work', async () => {
  const e1 = ask('e1', 1), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2], { title: { v: 'Hello', base: 0 } });
  const rec = await recordFor(doc);
  const tomb = applyDelete(doc, { e1: 1, e2: 1 }, NOW).doc;
  const local = thread('t1', [structuredClone(e1), { ...e2, text: 'edited offline' }], { title: 'Hello' });
  const plan = await planPull({ local, record: rec, remote: viewOf(tomb, rec.rev), uid });
  assert.deepEqual(plan.slots.map((s) => s.from), ['fork']);
  assert.equal(plan.slots[0].entry.forkOf, 'e2');
  assert.equal(plan.removeThread, false, 'the edit keeps the thread');
  assert.equal(plan.push, true);
  assert.deepEqual(plan.record.e, {});
  applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(local.entries.map((e) => e.text), ['edited offline']);
  assert.equal(local.title, 'Hello', 'the tombstone’s empty title is not adopted');
  // unsynced entries (no record) survive a tombstone and revive it
  const fresh = thread('t1', [structuredClone(e1), ask('e3', 3)], { title: 'Hello' });
  const plan2 = await planPull({ local: fresh, record: rec, remote: viewOf(tomb, rec.rev), uid });
  assert.deepEqual(plan2.slots.map((s) => [s.id, s.from]), [['e3', 'local']]);
  assert.equal(plan2.removeThread, false);
  // nothing left: the thread goes and the record remembers the delete
  const clean = thread('t1', [structuredClone(e1), structuredClone(e2)], { title: 'Hello' });
  const plan3 = await planPull({ local: clean, record: rec, remote: viewOf(tomb, rec.rev), uid });
  assert.equal(plan3.removeThread, true);
  assert.deepEqual(plan3.record.deleted, { at: NOW });
});

test('planPull defers threads with pending, run-locked or live entries', async () => {
  const e1 = ask('e1', 1);
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'remote' }], { bases: { e1: 1 } }), NOW).doc;
  const pending = thread('t1', [{ ...e1, text: 'gener', pending: true }]);
  assert.equal((await planPull({ local: pending, record: rec, remote: viewOf(doc2), uid })).defer, 'busy');
  const plain = thread('t1', [structuredClone(e1), { ...ask('e2', 2), text: 'x' }]);
  assert.equal((await planPull({ local: plain, record: rec, remote: viewOf(doc2), uid, locked: new Set(['e1']) })).defer, 'busy');
  assert.equal((await planPull({ local: plain, record: rec, remote: viewOf(doc2), uid, locked: (id) => id === 'e1' })).defer, 'busy');
  assert.equal((await planPull({ local: plain, record: rec, remote: viewOf(doc2), uid, live: true })).defer, 'live');
  assert.equal((await planPull({ local: plain, record: rec, remote: viewOf(doc2), uid, locked: new Set(['e2']) })).defer, null, 'a lock on an untouched entry');
  assert.equal((await planPull({ local: thread('t1', [structuredClone(e1)]), record: rec, remote: viewOf(doc), uid, live: true })).defer, null, 'nothing to change');
});

test('planPull inserts remote-only entries by (createdAt, id) and keeps the local order', async () => {
  const doc = await docOf('t1', [ask('r2', 2), ask('r5', 5), ask('r9', 9), ask('a5', 5)]);
  const local = thread('t1', [ask('l1', 1), ask('l6', 6), ask('l3', 3)]);
  const plan = await planPull({ local, record: null, remote: viewOf(doc), uid });
  assert.deepEqual(plan.slots.map((s) => s.id), ['l1', 'r2', 'a5', 'r5', 'l6', 'l3', 'r9']);
  assert.deepEqual(plan.added, ['r2', 'a5', 'r5', 'r9']);
});

test('planPull skips quarantined versions and takes the server title when this device never synced it', async () => {
  const doc = await docOf('t1', [ask('e1', 1), ask('e2', 2)], { title: { v: 'Server title', base: 0 } });
  const plan = await planPull({ local: null, record: null, remote: viewOf(doc), uid, quarantined: (id) => id === 'e2' });
  assert.deepEqual(plan.slots.map((s) => s.id), ['e1']);
  assert.equal(plan.record.e.e2, undefined);
  assert.equal(plan.title, 'Server title');
  const r = applyPlan(null, plan, await hydrateAll(plan));
  assert.equal(r.thread.id, 't1');
  assert.equal(r.thread.title, 'Server title');
  assert.deepEqual(r.thread.entries.map((e) => e.id), ['e1']);
});

test('applyPlan re-checks the thread and merges in place without swapping objects', async () => {
  const e1 = ask('e1', 1);
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'remote', meta: { model: 'm2' } }], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [{ ...structuredClone(e1), stage: 'Done', error: 'old error' }]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2), uid });
  const before = local.entries[0], arr = local.entries;
  // the user changed the entry after planning → nothing applied
  local.entries[0].text = 'typed meanwhile';
  assert.equal(applyPlan(local, plan, await hydrateAll(plan)).ok, false);
  assert.equal(local.entries[0].text, 'typed meanwhile');
  local.entries[0].text = e1.text;
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.equal(r.ok, true);
  assert.equal(local.entries, arr, 'same array');
  assert.equal(local.entries[0], before, 'same entry object');
  assert.equal(before.text, 'remote');
  assert.deepEqual(before.meta, { model: 'm2' });
  assert.equal('error' in before, false, 'keys absent remotely are removed');
  assert.equal(before.stage, 'Done', 'transient keys stay');
  assert.equal(sameSnap(before, plan.snaps.e1), false, 'the entry changed: its snapshot no longer matches');
  // a remote slot that couldn't be hydrated keeps the local copy and rolls its record back
  const local2 = thread('t1', [structuredClone(e1)]);
  const plan2 = await planPull({ local: local2, record: rec, remote: viewOf(doc2), uid });
  const r2 = applyPlan(local2, plan2, new Map());
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.skipped, ['e1']);
  assert.equal(local2.entries[0].text, e1.text);
  assert.deepEqual(r2.record.e.e1, rec.e.e1);
  assert.equal(r2.record.refetch, true);
});

// ── planPush ──
test('planPush never sends pending, locked, held, recovered (r > 0) or stale write-back entries', async () => {
  const e1 = ask('e1', 1), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2], { title: { v: 'T', base: 0 } });
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e2, text: 'v2' }], { bases: { e2: 1 } }), NOW).doc;
  rec.e.e2 = { r: 2, f: doc2.entries[1].h, g: doc2.entries[1].h, old: [rec.e.e2.f] };
  const t = thread('t1', [
    { ...e1, text: 'interrupted', recovered: true }, // recovered with r > 0 → refetch, not pushed
    structuredClone(e2), // the old copy: f in old → stale write-back → refetch
    { ...ask('p1', 3), pending: true },
    ask('l1', 4),
    { ...ask('m1', 5), images: [PNG] },
    { ...ask('s1', 6), steps: [{ status: 'awaiting' }] },
    { ...ask('r0', 7), recovered: true, text: 'partial' }, // r == 0: the only copy, so it IS pushed
    { ...ask('k1', 8), params: { $b: 1 } },
    ask('ok', 9),
  ], { title: 'T' });
  const plan = await planPush({ thread: t, record: rec, locked: new Set(['l1']), media: { image: false, video: false } });
  assert.deepEqual(plan.entries.map((e) => [e.id, e.base]), [['r0', 0], ['ok', 0]]);
  assert.deepEqual(plan.waiting.sort(), ['l1', 'p1', 's1']);
  assert.deepEqual(plan.held.map((h) => [h.id, h.reason]), [['m1', 'media'], ['k1', 'ref_key']]);
  assert.equal(plan.refetch, true);
  assert.equal(plan.title, null, 'title unchanged');
  for (const e of plan.entries) { assert.equal('recovered' in e.d, false); assert.equal(e.h, await entryHash(e.d)); }
  // phase 2: images go once the gate opens
  const p2 = await planPush({ thread: t, record: rec, locked: new Set(['l1']), media: { image: true, video: false } });
  assert.ok(p2.entries.some((e) => e.id === 'm1'));
  assert.deepEqual(p2.blobs.map((b) => b.t), ['image/png']);
  // thread-level exclusions ('lo:', 'hide:', 'del:', tooLarge, mode 'new') come in as skip
  for (const skip of ['local_only', 'hidden', 'deleting', 'too_large', 'mode_new']) {
    const s = await planPush({ thread: t, record: rec, skip });
    assert.deepEqual([s.skip, s.entries.length, s.dirty], [skip, 0, false]);
  }
});

test('planPush sends the title with entries or once synced, and pushBodies batches ≤ 200 entries', async () => {
  const t = thread('t1', Array.from({ length: 450 }, (_, i) => ask(`e${i}`, i)), { title: 'Big' });
  const plan = await planPush({ thread: t, record: null });
  assert.deepEqual(plan.title, { v: 'Big', base: 0 });
  const bodies = pushBodies(plan);
  assert.deepEqual(bodies.map((b) => b.entries.length), [200, 200, 50]);
  assert.deepEqual(bodies.map((b) => Boolean(b.title)), [true, false, false]);
  for (const b of bodies) assert.equal(checkPush(b), null);
  const emptyThread = await planPush({ thread: thread('t2', [], { title: 'Nothing yet' }), record: null });
  assert.equal(emptyThread.dirty, false, 'no document for a thread with nothing to send');
  const renamed = await planPush({ thread: thread('t3', [], { title: 'New name' }), record: { ...newRecord(), rev: 4, title: 'Old', titleRev: 2 } });
  assert.deepEqual(renamed.title, { v: 'New name', base: 2 });
  const undated = await planPush({ thread: thread('t4', [ask('e1', 50), ask('e2', 20)], { createdAt: undefined }), record: null });
  assert.equal(undated.createdAt, 20, 'falls back to the earliest entry');
  assert.equal(checkPush(pushBodies(undated)[0]), null);
});

// ── a small loop: devices ↔ one server document map ──
function server() { return { docs: new Map(), blobs: new Map(), clock: NOW }; }
function device() { return { threads: new Map(), records: new Map() }; }
async function push(dev, srv, id) {
  const t = dev.threads.get(id);
  const plan = await planPush({ thread: t, record: dev.records.get(id) || null });
  for (const b of plan.blobs) srv.blobs.set(b.hash, b.bytes());
  const results = [];
  for (const body of pushBodies(plan)) {
    const cur = srv.docs.get(id) || null;
    const out = applyPush(cur, body, ++srv.clock, id);
    if (out.changed) srv.docs.set(id, out.doc);
    const res = { ...out.response, etag: out.doc ? `e${out.doc.rev}` : null };
    const p = await planPushResult({ thread: t, record: dev.records.get(id) || null, sent: plan.sent, title: body.title, res, uid });
    const r = applyPlan(t, p, await hydrateAll(p, srv.blobs));
    assert.equal(r.ok, true);
    dev.records.set(id, r.record);
    results.push(p);
  }
  return results;
}
async function pull(dev, srv, id) {
  const doc = srv.docs.get(id), rec = dev.records.get(id) || null;
  const plan = await planPull({ local: dev.threads.get(id) || null, record: rec, remote: docView(doc, `e${doc.rev}`, rec && !rec.refetch ? rec.rev : null), uid });
  assert.equal(plan.defer, null);
  const r = applyPlan(dev.threads.get(id) || null, plan, await hydrateAll(plan, srv.blobs));
  assert.equal(r.ok, true);
  if (plan.removeThread) dev.threads.delete(id); else dev.threads.set(id, r.thread);
  dev.records.set(id, r.record);
  return plan;
}
const contentOf = (t) => t && t.entries.map((e) => canonical(strip(e)));

test('two devices: canva-imports from both sides converge to the union, in time order', async () => {
  const srv = server(), pc = device(), phone = device();
  pc.threads.set('canva-imports', thread('canva-imports', [ask('c1', 10), ask('c3', 30)], { title: 'From Canva' }));
  phone.threads.set('canva-imports', thread('canva-imports', [ask('c2', 20), ask('c4', 40)], { title: 'From Canva' }));
  await push(pc, srv, 'canva-imports');
  // first sync on the phone: pull first, then push
  await pull(phone, srv, 'canva-imports');
  await push(phone, srv, 'canva-imports');
  await pull(pc, srv, 'canva-imports');
  const a = pc.threads.get('canva-imports'), b = phone.threads.get('canva-imports');
  assert.deepEqual(a.entries.map((e) => e.id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(contentOf(a), contentOf(b));
  assert.deepEqual(srv.docs.get('canva-imports').entries.map((e) => e.id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(srv.docs.get('canva-imports').title, 'From Canva');
});

test('two devices: concurrent offline edits of one entry fork once, and a retry after a lost response is a no-op', async () => {
  const srv = server(), pc = device(), phone = device();
  pc.threads.set('t1', thread('t1', [ask('e1', 1), ask('e2', 2)], { title: 'Plans' }));
  await push(pc, srv, 't1');
  await pull(phone, srv, 't1');
  assert.deepEqual(contentOf(phone.threads.get('t1')), contentOf(pc.threads.get('t1')));
  // both edit e1 offline; the phone also adds an entry and renames
  pc.threads.get('t1').entries[0].text = 'pc version';
  Object.assign(phone.threads.get('t1').entries[0], { text: 'phone version' });
  phone.threads.get('t1').entries.push(ask('e3', 3));
  phone.threads.get('t1').title = 'Plans (phone)';
  await push(phone, srv, 't1');
  const [res] = await push(pc, srv, 't1'); // conflict on e1 → the pc version forks
  assert.equal(res.forks.length, 1);
  assert.equal(res.pull, true, 'the phone wrote since the pc last looked');
  await push(pc, srv, 't1'); // the fork goes up
  await pull(pc, srv, 't1');
  await pull(phone, srv, 't1');
  const a = pc.threads.get('t1'), b = phone.threads.get('t1');
  assert.deepEqual(contentOf(a), contentOf(b));
  assert.deepEqual(a.entries.map((e) => e.text), ['phone version', 'pc version', 'answer e2', 'answer e3']);
  assert.equal(a.entries[1].forkOf, 'e1');
  assert.equal(a.title, 'Plans (phone)');
  assert.equal(b.title, 'Plans (phone)');
  // nothing left to push on either side
  for (const dev of [pc, phone]) assert.equal((await planPush({ thread: dev.threads.get('t1'), record: dev.records.get('t1') })).dirty, false);
  // a lost response: the server applied it, the device re-sends the same body → the same revisions, no change
  const doc = srv.docs.get('t1');
  pc.threads.get('t1').entries[2].text = 'edited once';
  const plan = await planPush({ thread: pc.threads.get('t1'), record: pc.records.get('t1') });
  const [body] = pushBodies(plan);
  const first = applyPush(doc, body, NOW + 1e6);
  const second = applyPush(first.doc, body, NOW + 2e6);
  assert.equal(second.changed, false);
  assert.deepEqual(second.response.accepted, first.response.accepted);
});

test('two devices: a delete removes the thread everywhere unless the other device changed it after the deleter looked', async () => {
  const srv = server(), pc = device(), phone = device();
  pc.threads.set('t1', thread('t1', [ask('e1', 1), ask('e2', 2)], { title: 'Doomed' }));
  await push(pc, srv, 't1');
  await pull(phone, srv, 't1');
  // the phone edits e2 and syncs; the pc deletes having seen e2 at rev 1
  phone.threads.get('t1').entries[1].text = 'phone kept working';
  await push(phone, srv, 't1');
  const seen = Object.fromEntries(Object.entries(pc.records.get('t1').e).map(([id, k]) => [id, k.r]));
  const del = applyDelete(srv.docs.get('t1'), seen, NOW + 50);
  srv.docs.set('t1', del.doc);
  assert.deepEqual([del.removed, del.kept], [['e1'], ['e2']]);
  pc.threads.delete('t1'); pc.records.delete('t1');
  await pull(pc, srv, 't1');
  await pull(phone, srv, 't1');
  assert.deepEqual(pc.threads.get('t1').entries.map((e) => e.text), ['phone kept working']);
  assert.deepEqual(contentOf(pc.threads.get('t1')), contentOf(phone.threads.get('t1')));
  // deleting the rest removes it on the phone too; nothing comes back
  const seen2 = Object.fromEntries(Object.entries(pc.records.get('t1').e).map(([id, k]) => [id, k.r]));
  srv.docs.set('t1', applyDelete(srv.docs.get('t1'), seen2, NOW + 60).doc);
  const p = await pull(phone, srv, 't1');
  assert.equal(p.removeThread, true);
  assert.equal(phone.threads.has('t1'), false);
});

test('forkEntry copies without sharing structure and keeps createdAt; quickPrint notices any change', () => {
  const e = { ...ask('e1', 7), params: { a: [1] }, pending: false, stage: 's', recovered: true };
  const f = forkEntry(e, 'new-id');
  assert.deepEqual([f.id, f.forkOf, f.createdAt, f.recovered, 'stage' in f, 'pending' in f], ['new-id', 'e1', 7, true, false, false]);
  f.params.a.push(2);
  assert.deepEqual(e.params.a, [1]);
  const p = quickPrint(e);
  assert.equal(quickPrint(structuredClone(e)), p);
  assert.notEqual(quickPrint({ ...e, text: e.text + '!' }), p);
  const long = { ...e, text: 'x'.repeat(10_000) };
  assert.notEqual(quickPrint({ ...long, text: 'x'.repeat(9_999) + 'y' }), quickPrint(long), 'the tail is covered');
  assert.notEqual(quickPrint({ ...long, text: `${'x'.repeat(5_000)}y${'x'.repeat(4_999)}` }), quickPrint(long), 'and the middle');
  assert.equal(quickPrint(undefined), null);
});

// ── found by tests/sync-sim.test.mjs ──
test('a fork sorts directly after its original on the server and on every device, whatever its id', async () => {
  // the fork's id sorts before the original's: (createdAt, id) alone would put it first everywhere but where it was made
  const orig = ask('zz', 5), sib = ask('mm', 5), fork = { ...ask('aa', 5, 'local version'), forkOf: 'zz' };
  assert.deepEqual(sortEntries([{ id: 'aa', createdAt: 5, d: fork }, { id: 'zz', createdAt: 5, d: orig }, { id: 'mm', createdAt: 5, d: sib }]).map((e) => e.id), ['mm', 'zz', 'aa']);
  const doc = await docOf('t1', [orig, fork, ask('y', 6)]);
  assert.deepEqual(doc.entries.map((e) => e.id), ['zz', 'aa', 'y']);
  // a device that has the original gets the fork right after it
  const local = thread('t1', [ask('zz', 5), ask('y', 6)]);
  const plan = await planPull({ local, record: await recordFor(await docOf('t1', [orig, ask('y', 6)])), remote: viewOf(doc), uid });
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(r.thread.entries.map((e) => e.id), ['zz', 'aa', 'y']);
});

test('restarted history: a server copy from another lineage or a rollback is never adopted on the record’s say-so', async () => {
  // the pc synced e1 at rev 3 (V3); the server then lost the thread and the phone re-created it with its crash-recovered
  // copy (rev 1, a new born). The pc's V3 is "unchanged since its record" — but that record describes the old lineage.
  let old = await docOf('t1', [ask('e1', 1, 'V1')]);
  old = applyPush(old, await bodyOf([ask('e1', 1, 'V2')], { bases: { e1: 1 } }), NOW).doc;
  old = applyPush(old, await bodyOf([ask('e1', 1, 'V3')], { bases: { e1: 2 } }), NOW).doc;
  const pcThread = () => thread('t1', [ask('e1', 1, 'V3')]);
  const pcRec = { ...(await recordFor(old)), born: NOW, e: { e1: { r: 3, f: old.entries[0].h, g: old.entries[0].h, old: old.entries[0].hh } } };
  const remade = applyPush(null, await bodyOf([ask('e1', 1, 'partial')]), NOW + 5000, 't1').doc;
  assert.equal(remade.born, NOW + 5000);
  await assert.rejects(planPull({ local: pcThread(), record: pcRec, remote: viewOf(remade, 1), uid }), /full view/, 'never a delta across lineages');
  const pcLocal = pcThread();
  const plan = await planPull({ local: pcLocal, record: pcRec, remote: viewOf(remade), uid });
  const r = applyPlan(pcLocal, plan, await hydrateAll(plan));
  assert.deepEqual(r.thread.entries.map((e) => e.text), ['partial', 'V3'], 'V3 survives as a fork instead of being replaced');
  assert.equal(r.thread.entries[1].forkOf, 'e1');
  assert.equal(r.record.born, NOW + 5000);
  // a rollback in the same lineage to a version this device already moved past: the local one goes back up
  const rolledBack = { ...old, rev: 1, entries: [{ ...old.entries[0], rev: 1, h: old.entries[0].hh[1], d: (await bodyOf([ask('e1', 1, 'V1')])).entries[0].d, hh: [] }] };
  const rbLocal = pcThread();
  const rb = await planPull({ local: rbLocal, record: pcRec, remote: viewOf(rolledBack), uid });
  assert.deepEqual(rb.slots.map((s) => s.from), ['local']);
  assert.equal(rb.push, true);
  const next = await planPush({ thread: rbLocal, record: applyPlan(rbLocal, rb, new Map()).record });
  assert.deepEqual(next.entries.map((e) => [e.id, e.base, e.d.text]), [['e1', 1, 'V3']], 'pushed over the rolled-back copy');
  // a push answered by another lineage pulls the whole thread instead of trusting prevRev
  const res = { ...applyPush(remade, await bodyOf([ask('e2', 2)]), NOW + 6000).response, etag: 'x' };
  assert.equal(res.prevRev, 1);
  const p = await planPushResult({ thread: thread('t1', [ask('e1', 1, 'V3'), ask('e2', 2)]), record: { ...pcRec, rev: 1 }, sent: {}, res, uid });
  assert.equal(p.pull, true);
  assert.deepEqual([p.record.rev, p.record.born], [1, NOW], 'rev and lineage are left for that pull');
});

test('a push whose answer was lost: the device recognises its own write (record pend) instead of forking against it', async () => {
  let doc = await docOf('t1', [ask('e1', 1, 'V1')]);
  const rec = { ...(await recordFor(doc)), born: NOW };
  // the device pushes V2 (noting it as pending), the server stores it, the answer never arrives; then a retry makes V3
  const v2 = (await bodyOf([ask('e1', 1, 'V2')], { bases: { e1: 1 } }));
  doc = applyPush(doc, v2, NOW).doc;
  rec.e.e1 = { ...rec.e.e1, pend: [v2.entries[0].h] };
  const local = thread('t1', [ask('e1', 1, 'V3')]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc, 1), uid });
  assert.deepEqual([plan.slots.map((s) => s.from), plan.how.e1, plan.push], [['local'], 'own', true]);
  const r = applyPlan(local, plan, new Map());
  const next = await planPush({ thread: r.thread, record: r.record });
  assert.deepEqual(next.entries.map((e) => [e.id, e.base, e.d.text]), [['e1', 2, 'V3']], 'V3 goes up over V2, no fork');
  assert.equal(applyPush(doc, pushBodies(next)[0], NOW).response.accepted.e1, 3);
});

test('an entry deleted everywhere stays remembered (record.dead): a stale copy is never pushed back, a restore is adopted', async () => {
  let doc = await docOf('t1', [ask('e1', 1, 'V1'), ask('e2', 2)]);
  doc = applyPush(doc, await bodyOf([ask('e1', 1, 'V2')], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [ask('e1', 1, 'V2'), ask('e2', 2)]);
  let rec = await recordFor(doc);
  rec.e.e1.old = doc.entries[0].hh;
  // another device deletes e1 only (the thread lives on): this device removes it and remembers it
  const del = applyDelete(doc, { e1: 2 }, NOW);
  let plan = await planPull({ local, record: rec, remote: viewOf(del.doc, rec.rev), uid });
  let r = applyPlan(local, plan, new Map());
  assert.deepEqual(r.thread.entries.map((e) => e.id), ['e2']);
  assert.equal(r.record.e.e1, undefined);
  assert.equal(r.record.dead.e1.r, 2);
  rec = r.record;
  // a stale tab puts the old copy (V1) back: not pushed, a full pull removes it again
  const stale = thread('t1', [ask('e1', 1, 'V1'), ask('e2', 2)]);
  const push = await planPush({ thread: stale, record: rec });
  assert.deepEqual([push.entries.length, push.refetch], [0, true]);
  plan = await planPull({ local: stale, record: rec, remote: viewOf(del.doc), uid });
  assert.deepEqual(applyPlan(stale, plan, new Map()).thread.entries.map((e) => e.id), ['e2']);
  // the owner restores it from Recently deleted: a device holding an older copy adopts the restored one, no fork
  const restored = applyRestore(del.doc, doc, NOW).doc;
  const older = thread('t1', [ask('e1', 1, 'V1'), ask('e2', 2)]);
  plan = await planPull({ local: older, record: rec, remote: viewOf(restored), uid });
  r = applyPlan(older, plan, await hydrateAll(plan));
  assert.deepEqual([r.thread.entries.map((e) => e.text), plan.forks], [['V2', 'answer e2'], []]);
  assert.equal(r.record.dead?.e1, undefined, 'back among the living');
});

test('an entry changed while a plan is computed makes the plan stale (it is never overwritten from older content)', async () => {
  const doc = applyPush(await docOf('t1', [ask('e1', 1, 'V1')]), await bodyOf([ask('e1', 1, 'server V2')], { bases: { e1: 1 } }), NOW).doc;
  const rec = await recordFor(await docOf('t1', [ask('e1', 1, 'V1')]));
  const open = thread('t1', [ask('e1', 1, 'V1')]);
  // the open entry is unchanged since the record, so the plan adopts the server's V2 — but a retry settles mid-plan
  const hashOf = async (e) => { const x = await dehydrate(e); open.entries[0].text = 'just settled'; return x; };
  const plan = await planPull({ local: open, record: rec, remote: viewOf(doc, 1), uid, hashOf });
  assert.equal(plan.how.e1, 'adopt');
  assert.deepEqual(applyPlan(open, plan, await hydrateAll(plan)), { ok: false });
  assert.equal(open.entries[0].text, 'just settled');
});

test('planPush decides from one look at each entry: a retry starting mid-plan never sends an interrupted copy', async () => {
  const doc = await docOf('t1', [ask('e1', 1, 'the answer')]);
  const rec = await recordFor(doc);
  const open = thread('t1', [{ ...ask('e1', 1, 'half an ans'), recovered: true, error: 'Interrupted' }]);
  // the user taps Retry while the plan awaits the hash: recovered goes, pending comes
  const hashOf = async (e) => { const x = dehydrate(e); Object.assign(open.entries[0], { pending: true, text: '' }); delete open.entries[0].recovered; return x; };
  const plan = await planPush({ thread: open, record: rec, hashOf });
  assert.deepEqual([plan.entries.length, plan.refetch], [0, true], 'the recovered snapshot is not pushed');
});

// Found by the overlap-mode simulation (seed 485) while verifying the review fixes: after the server lost a thread, a
// stale copy went up (record.lost lets it: it may be the only copy left); recording that push moved the newer version
// into k.old, so when another device put the newer version back, this device "rewound" it with the stale copy.
test('a stale copy pushed after a server loss never marks the newer version as superseded', async () => {
  let old = await docOf('t1', [ask('e5', 1, 'v11')]);
  old = applyPush(old, await bodyOf([ask('e5', 1, 'v25')], { bases: { e5: 1 } }), NOW).doc;
  const [h11, h25] = [old.entries[0].hh[0], old.entries[0].h];
  const pcRec = { ...(await recordFor(old)), born: NOW, lost: true, e: { e5: { r: 2, f: h25, g: h25, old: [h11] } } };
  const stale = thread('t1', [ask('e5', 1, 'v11')]); // a stale tab's copy, written back after the loss
  const plan = await planPush({ thread: stale, record: pcRec });
  assert.deepEqual(plan.entries.map((e) => [e.id, e.base, e.d.text]), [['e5', 0, 'v11']], 'lost: even a stale copy goes up');
  const remade = applyPush(null, pushBodies(plan)[0], NOW + 5000, 't1');
  const p = await planPushResult({ thread: stale, record: pcRec, sent: plan.sent, res: { ...remade.response, etag: 'x' }, uid });
  assert.deepEqual(p.record.e.e5.old, [], 'v25 is not "older" than the stale copy that just landed');
  // another device, which knew v25, puts it back over v11 (its own record: v11 is older)
  const back = applyPush(remade.doc, { ...(await bodyOf([ask('e5', 1, 'v25')], { bases: { e5: 1 } })), born: NOW + 5000 }, NOW + 6000).doc;
  assert.equal(back.entries[0].d.text, 'v25');
  const pull = await planPull({ local: stale, record: p.record, remote: viewOf(back), uid });
  assert.notEqual(pull.how.e5, 'rewound');
  const r = applyPlan(stale, pull, await hydrateAll(pull));
  assert.equal(r.thread.entries[0].text, 'v25', 'the newer version stays');
  const next = await planPush({ thread: r.thread, record: r.record });
  assert.ok(!next.entries.some((e) => e.id === 'e5' && e.d.text === 'v11'), 'and the stale copy never goes over it');
});

// Found by the overlap-mode simulation (seed 514; the rule predates the review): an entry the re-created server
// document lacks is pushed again with base 0, and its record kept older versions — but dropped the one it last synced
// (k.f). A stale tab's copy of exactly that version then went up over the newer local answer.
test('re-pushing what the server lost keeps the last synced version as an older one when the local copy moved past it', async () => {
  const doc = await docOf('t1', [ask('e10', 1, 'v18')]);
  const rec = { ...(await recordFor(doc)), born: NOW };
  const h18 = doc.entries[0].h;
  const local = thread('t1', [ask('e10', 1, 'v41')]); // retried here, on top of v18
  const remade = applyPush(null, await bodyOf([ask('e14', 2)]), NOW + 5000, 't1').doc; // the server lost it; another entry re-created it
  const plan = await planPull({ local, record: rec, remote: viewOf(remade), uid });
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(r.record.e.e10.r, 0);
  assert.ok(r.record.e.e10.old.includes(h18), 'v18 is remembered as older');
  const up = await planPush({ thread: r.thread, record: r.record });
  assert.deepEqual(up.entries.filter((e) => e.id === 'e10').map((e) => [e.base, e.d.text]), [[0, 'v41']], 'the newer answer goes up');
  const stale = await planPush({ thread: thread('t1', [ask('e10', 1, 'v18'), ask('e14', 2)]), record: r.record });
  assert.equal(stale.entries.some((e) => e.id === 'e10'), false, 'a stale tab\'s v18 never does');
  // unchanged since the last sync: that copy goes up again (it must stay pushable)
  const same = await planPull({ local: thread('t1', [ask('e10', 1, 'v18')]), record: rec, remote: viewOf(remade), uid });
  assert.equal(same.record.e.e10.old.includes(h18), false);
});

// ── review findings (each failed before its fix) ──
// A conflicting server version this device can't validate (quarantined) or hydrate yet (parked): a push answer used to
// resolve it into [adopt S, fork L] anyway; applyPlan skipped S but kept the fork — a new fork on every push.
test('a quarantined or parked server version is left unresolved by a push answer, and a skipped adopt drops its fork', async () => {
  const e1 = ask('e1', 1, 'v0');
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'other device' }], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [{ ...e1, text: 'mine' }]);
  const res = { ...applyPush(doc2, await bodyOf([local.entries[0]], { bases: { e1: 1 } }), NOW).response, etag: 'x' };
  assert.equal(res.conflicts.length, 1);
  const S = res.conflicts[0];
  for (const opt of [{ quarantined: (id, h) => id === S.id && h === S.h }, { parked: (id, h) => id === S.id && h === S.h }]) {
    const p = await planPushResult({ thread: local, record: rec, sent: {}, res, uid, ...opt });
    assert.deepEqual(p.slots.map((s) => s.from), ['local'], 'no fork planned');
    assert.equal(p.push, false);
    assert.deepEqual(p.record.e.e1, rec.e.e1, 'the record keeps its base: the local version stays unsynced');
  }
  // the same conflict without the check plans [adopt, fork]; if the adopt can't be hydrated the fork is dropped too
  const p = await planPushResult({ thread: local, record: rec, sent: {}, res, uid });
  assert.deepEqual(p.slots.map((s) => s.from), ['remote', 'fork']);
  const r = applyPlan(local, p, new Map());
  assert.deepEqual(r.thread.entries.map((e) => [e.id, e.text]), [['e1', 'mine']], 'the local version stays, once');
  assert.deepEqual([r.forks, r.skipped], [[], ['e1']]);
  // planPull's first encounter (before the quarantine key exists) is covered by the same applyPlan rule
  const pullLocal = thread('t1', [{ ...e1, text: 'mine' }]);
  const pull = await planPull({ local: pullLocal, record: rec, remote: viewOf(doc2, 1), uid });
  assert.deepEqual(pull.slots.map((s) => s.from), ['remote', 'fork']);
  assert.deepEqual(applyPlan(pullLocal, pull, new Map()).thread.entries.map((e) => e.id), ['e1']);
});

// A push answer for a thread that is generating: its run saves its own object over whatever is merged into IndexedDB,
// so only the accepted revisions are recorded; conflicts wait for a pull after the run (with the rev left behind).
test('planPushResult on a live thread records accepted revisions only and defers everything else', async () => {
  const e1 = ask('e1', 1, 'v0'), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const doc2 = applyPush(doc, await bodyOf([{ ...e1, text: 'phone edit' }], { bases: { e1: 1 } }), NOW).doc;
  const local = thread('t1', [{ ...e1, text: 'pc edit' }, e2]);
  const body = await bodyOf(local.entries, { bases: { e1: 1 } });
  const res = { ...applyPush(doc2, body, NOW).response, etag: 'x2' };
  const sent = Object.fromEntries(body.entries.map((e) => [e.id, { h: e.h, g: e.h, base: e.base }]));
  const p = await planPushResult({ thread: local, record: rec, sent, res, uid, live: true });
  assert.deepEqual([p.deferred, p.pull, p.push, p.changed, p.forks], [true, true, false, false, []]);
  assert.deepEqual(p.slots.map((s) => s.from), ['local', 'local'], 'nothing is merged into the generating thread');
  assert.equal(p.record.e.e2.r, 1, 'the accepted entry is recorded');
  assert.deepEqual(p.record.e.e1, rec.e.e1, 'the conflicting one keeps its base');
  assert.equal(p.record.rev, rec.rev, 'rev stays, so the pull after the run still sees the conflict');
  // nothing to defer: rev and etag move on
  const clean = { ...applyPush(doc, await bodyOf([e2]), NOW).response, etag: 'x3' };
  const q = await planPushResult({ thread: thread('t1', [e1, e2]), record: rec, sent: { e2: sent.e2 }, res: clean, uid, live: true });
  assert.deepEqual([q.deferred, q.pull, q.record.rev, q.record.etag], [false, false, clean.rev, 'x3']);
});

// Push bodies carry the lineage their bases belong to: after the server lost a thread and a device re-created it, a
// push based on the old lineage's revisions replaces nothing (it used to overwrite a concurrent edit silently).
test('applyPush across lineages: a base from another born never replaces; pushBodies carries born; checkPush validates it', async () => {
  const remade = applyPush(null, await bodyOf([ask('e1', 1, 'pc edit')], { title: { v: 'Plans', base: 0 } }), NOW + 2000, 't1').doc;
  assert.deepEqual([remade.entries[0].rev, remade.title, remade.titleRev], [1, 'Plans', 1]);
  const stale = { ...(await bodyOf([ask('e1', 1, 'phone edit')], { bases: { e1: 1 }, title: { v: 'Renamed', base: 1 } })), born: NOW };
  const out = applyPush(remade, stale, NOW + 3000);
  assert.equal(out.response.conflicts.length, 1, 'a conflict, not a replace');
  assert.equal(out.doc.entries[0].d.text, 'pc edit');
  assert.equal(out.doc.title, 'Plans', 'the title base belongs to the old lineage too');
  // same lineage: replaced as before
  assert.equal(applyPush(remade, { ...stale, born: NOW + 2000 }, NOW + 3000).doc.entries[0].d.text, 'phone edit');
  // no born (an older client, or a record that never got an answer): treated as the same lineage
  const { born, ...noBorn } = stale;
  assert.equal(born, NOW);
  assert.equal(applyPush(remade, noBorn, NOW + 3000).doc.entries[0].d.text, 'phone edit');
  // the same h from the other lineage is still a no-op
  const same = applyPush(remade, { ...(await bodyOf([ask('e1', 1, 'pc edit')], { bases: { e1: 7 } })), born: NOW }, NOW + 3000);
  assert.deepEqual([same.changed, same.response.accepted], [false, { e1: 1 }]);
  const plan = await planPush({ thread: thread('t1', [ask('e1', 1, 'x')]), record: { ...newRecord(), born: NOW, rev: 1, e: {} } });
  assert.equal(pushBodies(plan)[0].born, NOW);
  const lost = await planPush({ thread: thread('t1', [ask('e1', 1, 'x')]), record: { ...newRecord(), born: NOW, lost: true } });
  assert.equal(pushBodies(lost)[0].born, undefined, 'lost: every base is 0 anyway');
  assert.equal(checkPush({ ...stale, born: 'x' }).code, 'bad_shape');
  assert.equal(checkPush(stale), null);
});

// betterFileRef used to accept any record with a numeric expiresAt, so the 'rebase' path wrote a server FileRef the app
// rejects (wrong uri, bad name, huge expiry) into a local entry — and Export then failed on that thread.
test('a FileRef is valid exactly when video.js accepts it; betterFileRef and the rebase path never take a bad one', async () => {
  const good = file('abc', NOW + 40 * 3600e3);
  const bad = [
    { ...good, uri: 'https://evil.example/x' }, { ...good, name: 'evil' }, { ...good, expiresAt: 9e15 }, { ...good, expiresAt: -1 },
    { ...good, mime: 7 }, { name: good.name, uri: good.uri },
  ];
  const vv = (f) => validVideo(video(f));
  assert.deepEqual([validFileRef(good), vv(good)], [true, true]);
  for (const f of bad) assert.deepEqual([validFileRef(f), vv(f)], [false, false], JSON.stringify(f));
  for (const f of [null, 'files/abc', 7]) assert.equal(validFileRef(f), false);
  const evil = { name: 'evil', uri: 'https://evil.example/x', expiresAt: 9e15 };
  assert.equal(betterFileRef(good, evil, NOW), good, 'the later expiry of an invalid ref never wins');
  assert.equal(betterFileRef(null, evil, NOW), null);
  // the rebase case: the local text changed, the server changed only video.file (to a bad ref)
  const base = { ...ask('v1', 1, 'clip'), kind: 'video', video: { ...video(good), clipOnly: true } };
  const doc = await docOf('t1', [base]);
  const rec = await recordFor(doc);
  const serverD = { ...structuredClone(doc.entries[0].d), video: { ...doc.entries[0].d.video, file: evil } };
  const h = await entryHash(serverD);
  const doc2 = { ...doc, rev: 2, entries: [{ ...doc.entries[0], rev: 2, s: 2, h, hh: [doc.entries[0].h], d: serverD }] };
  const local = thread('t1', [{ ...structuredClone(base), text: 'edited here' }]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2), uid, now: NOW });
  assert.equal(plan.how.v1, 'rebase');
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.deepEqual(r.thread.entries[0].video.file, good, 'the local valid FileRef stays');
  assert.equal(validVideo(r.thread.entries[0].video), true);
});

// v56 review: the open-copy refresh (sync.js patchInPlace sorted) and a pull (buildSlots) must place a new entry the
// same way, or the open copy and IndexedDB disagree on the order. A local entry with no usable createdAt (it never
// syncs) is passed over by both instead of being compared as NaN (which fell through to the id).
test('buildSlots: a local entry without a createdAt is passed over when placing a pulled entry (as patchInPlace sorted does)', async () => {
  const doc = await docOf('t1', [ask('e1', 1), ask('e9', 9)]);
  const rec = await recordFor(doc);
  const doc2 = await docOf('t1', [ask('e1', 1), ask('e5', 5), ask('e9', 9)]);
  const legacy = { ...ask('ex', 0), createdAt: undefined };
  const local = thread('t1', [ask('e1', 1), legacy, ask('e9', 9)], { title: '' });
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2), uid });
  assert.deepEqual(plan.slots.map((s) => s.id), ['e1', 'ex', 'e5', 'e9']);
});

// ── phases 2-3 ──
test('planPush holdBlobs: a large video waits (with its size) unless it is already on the server; MEDIA_HELD names the media reasons', async () => {
  const e1 = { ...ask('v1', 1, ''), kind: 'video', media: [{ type: 'video', src: MP4 }] }, e2 = ask('t2', 2), e3 = { ...ask('i3', 3), images: [PNG] };
  const hold = (blobs) => (blobs.some((b) => b.kind === 'video') ? 'wifi' : null);
  const plan = await planPush({ thread: thread('t1', [e1, e2, e3]), holdBlobs: hold });
  assert.deepEqual(plan.entries.map((e) => e.id), ['t2', 'i3']);
  assert.deepEqual(plan.held, [{ id: 'v1', reason: 'wifi', bytes: Buffer.from('mp4-bytes').length }]);
  assert.deepEqual(plan.blobs.map((b) => b.t), ['image/png'], 'the held video is not uploaded');
  assert.deepEqual(MEDIA_HELD, ['media', 'wifi', 'blob_too_large']);
  // already synced as it is: nothing to send, so nothing to wait for (and no "waiting for Wi-Fi" for it)
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const again = await planPush({ thread: thread('t1', [e1]), record: rec, holdBlobs: hold });
  assert.deepEqual([again.entries.length, again.held.length], [0, 0]);
});

test('planPull clears the "only waiting for media" mark, so a full read decides it afresh', async () => {
  const doc = await docOf('t1', [ask('e1', 1)]);
  const rec = { ...(await recordFor(doc)), refetch: true, wait: true };
  const plan = await planPull({ local: thread('t1', [ask('e1', 1)]), record: rec, remote: docView(doc, 'etag1'), uid });
  assert.equal('wait' in plan.record, false);
  assert.equal('refetch' in plan.record, false);
});

test('planPull: a pending entry no tab is generating (orphans) no longer holds the thread back; a locked or unlisted one still does', async () => {
  const e1 = ask('e1', 1), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2]);
  const rec = await recordFor(doc);
  const del = applyDelete(doc, { e1: 1, e2: 1 }, NOW + 1).doc; // deleted everywhere
  const back = applyPush(del, await bodyOf([ask('e3', 3)]), NOW + 2, 't1').doc; // and revived by a new entry
  const local = thread('t1', [e1, { ...e2, pending: true, text: '' }]);
  const view = docView(back, 'etag2');
  const held = await planPull({ local, record: rec, remote: view, uid });
  assert.equal(held.defer, 'busy', 'a pending entry waits by default');
  const locked = await planPull({ local, record: rec, remote: view, uid, orphans: new Set(['e2']), locked: new Set(['e2']) });
  assert.equal(locked.defer, 'busy', 'a run lock wins over the orphan list');
  const plan = await planPull({ local, record: rec, remote: view, uid, orphans: new Set(['e2']) });
  assert.equal(plan.defer, null);
  assert.deepEqual(plan.slots.map((x) => [x.id, x.from]), [['e3', 'remote']], 'the orphan goes with the delete, like a recovered entry');
});

test('planPull (full): an entry gone from both the server and this device keeps its history in record.dead, so a stale copy written back later is recognised', async () => {
  const e1 = ask('e1', 1, 'v-old'), e2 = ask('e2', 2);
  const doc = await docOf('t1', [e1, e2]);
  const rec = await recordFor(doc);
  const fOld = rec.e.e1.f;
  // the server lost the thread; another device re-created it without e1; this device's copy lacks e1 too
  const again = await docOf('t1', [e2]);
  const plan = await planPull({ local: thread('t1', [e2]), record: rec, remote: docView({ ...again, born: NOW + 5 }, 'etag9'), uid });
  assert.equal(plan.record.e.e1, undefined);
  assert.equal(plan.record.dead.e1.f, fOld, 'what it knew of e1 stays');
  // e1 comes back (newer) from another device: its record remembers the old version, so a stale write-back of it is old
  const newer = applyPush(again, await bodyOf([ask('e1', 1, 'v-new')]), NOW + 6).doc;
  const p2 = await planPull({ local: thread('t1', [e2]), record: plan.record, remote: docView(newer, 'etag10'), uid });
  assert.ok(p2.record.e.e1.old.includes(fOld));
  const push = await planPush({ thread: thread('t1', [e1, e2]), record: p2.record });
  assert.deepEqual([push.entries.length, push.refetch], [0, true], 'the stale copy is never pushed over the newer answer');
});

// ── marks that make a later accounts-agent turn ask first (e.untrusted, e.imported, e.web, steps) ──
test('the untrusted mark, the live-web count, the imported flag and agent steps all sync; STICKY names the marks that never come off', () => {
  const e = ask('e1', 1, 'a', { untrusted: 'share', web: 2, imported: true, steps: [{ id: 's', name: 'browser_read', service: 'browser', status: 'done' }], meta: { note: 'live web' } });
  const s = strip(e);
  for (const k of ['untrusted', 'web', 'imported', 'steps', 'meta']) assert.deepEqual(s[k], e[k], k);
  assert.deepEqual([...STICKY], ['untrusted', 'imported']);
  for (const k of STICKY) assert.equal(TRANSIENT.includes(k), false, `${k} is not transient`);
});

test('a pulled version that lacks a mark the local copy has never unmarks it: the mark stays, goes back up, and the server keeps it', async () => {
  const e1 = ask('e1', 1, 'answer', { untrusted: 'share' });
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  // another device (an old build, a bug) pushes a version without the mark
  const { untrusted, ...bare } = e1;
  const doc2 = applyPush(doc, await bodyOf([{ ...bare, text: 'answer, edited' }], { bases: { e1: 1 } }), NOW).doc;
  assert.equal('untrusted' in doc2.entries[0].d, false);
  const local = thread('t1', [structuredClone(e1)]);
  const plan = await planPull({ local, record: rec, remote: viewOf(doc2, rec.rev), uid });
  assert.deepEqual(plan.slots.map((s) => [s.id, s.from, s.keep]), [['e1', 'remote', ['untrusted']]]);
  assert.equal(plan.push, true);
  assert.equal(plan.how.e1, 'adopt+marks');
  const r = applyPlan(local, plan, await hydrateAll(plan));
  assert.equal(r.ok, true);
  assert.equal(local.entries[0].text, 'answer, edited', 'the other change is taken');
  assert.equal(local.entries[0].untrusted, 'share', 'the mark is not');
  // the marked copy goes up over the server's (never mistaken for a stale write-back) and the server stores it
  const push = await planPush({ thread: local, record: r.record });
  assert.deepEqual(push.entries.map((x) => [x.id, x.base, x.d.untrusted]), [['e1', 2, 'share']]);
  const doc3 = applyPush(doc2, pushBodies(push)[0], NOW).doc;
  assert.equal(doc3.entries[0].d.untrusted, 'share');
  assert.equal(doc3.entries[0].d.text, 'answer, edited');
  // the device that dropped it takes the marked version back (its copy is unchanged since it pushed)
  const other = thread('t1', [{ ...structuredClone(bare), text: 'answer, edited' }]);
  const otherRec = await recordFor(doc2);
  const back = await planPull({ local: other, record: otherRec, remote: viewOf(doc3, otherRec.rev), uid });
  assert.deepEqual(back.slots.map((s) => [s.from, s.keep]), [['remote', undefined]]);
  applyPlan(other, back, await hydrateAll(back));
  assert.equal(other.entries[0].untrusted, 'share');
  // an entry that never had a mark adopts as before
  const bdoc = await docOf('t3', [bare]);
  const bdoc2 = applyPush(bdoc, await bodyOf([{ ...bare, text: 'x' }], { bases: { e1: 1 } }), NOW).doc;
  const p2 = await planPull({ local: thread('t3', [structuredClone(bare)]), record: await recordFor(bdoc), remote: viewOf(bdoc2, 1), uid });
  assert.deepEqual(p2.slots.map((s) => [s.from, s.keep]), [['remote', undefined]]);
  assert.equal(p2.how.e1, 'adopt');
  // the imported flag is sticky the same way
  const i1 = ask('i1', 1, 'restored', { imported: true });
  const idoc = await docOf('t2', [i1]);
  const { imported, ...ibare } = i1;
  const idoc2 = applyPush(idoc, await bodyOf([{ ...ibare, text: 'x' }], { bases: { i1: 1 } }), NOW).doc;
  const ilocal = thread('t2', [structuredClone(i1)]);
  const iplan = await planPull({ local: ilocal, record: await recordFor(idoc), remote: viewOf(idoc2, 1), uid });
  applyPlan(ilocal, iplan, await hydrateAll(iplan));
  assert.equal(ilocal.entries[0].imported, true);
});

test('a push answered with a version that lacks the mark (stale or conflict) keeps it the same way', async () => {
  const e1 = ask('e1', 1, 'answer', { untrusted: 'link' });
  const doc = await docOf('t1', [e1]);
  const rec = await recordFor(doc);
  const { untrusted, ...bare } = e1;
  const doc2 = applyPush(doc, await bodyOf([{ ...bare, text: 'from elsewhere' }], { bases: { e1: 1 } }), NOW).doc;
  // this device edits the marked entry offline and pushes on base 1: the server answers with a conflict
  const local = thread('t1', [{ ...structuredClone(e1), text: 'edited here' }]);
  const push = await planPush({ thread: local, record: rec });
  const res = applyPush(doc2, pushBodies(push)[0], NOW).response;
  assert.equal(res.conflicts.length, 1);
  const plan = await planPushResult({ thread: local, record: rec, sent: push.sent, res, uid });
  const adopted = plan.slots.find((s) => s.id === 'e1');
  assert.deepEqual([adopted.from, adopted.keep], ['remote', ['untrusted']]);
  applyPlan(local, plan, await hydrateAll(plan));
  assert.equal(local.entries.find((x) => x.id === 'e1').untrusted, 'link');
  assert.ok(local.entries.every((x) => x.untrusted === 'link'), 'the fork of the local edit keeps it too');
});
