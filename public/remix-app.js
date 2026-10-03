// Video Remix: the controller. createRemix(deps) owns everything a remix entry does after app.js routes a send to it:
// the composer (attach checks, notes, options, the send gate), planning (one Gemini run through app.js streamChat),
// the review (story view, cost card, Fine-tune sheet), approval, filming (the job registry: the ONLY writer of shot
// state, stepping remix-shots.js advanceShot and saving through remix-store.js), the cut (remix-render.js, lazy) and
// recovery at boot. Every app.js function it needs arrives in `deps`, so wiring it is a small text-anchored patch
// (remix-integration.md) and tests/remix-app.test.mjs drives it with fakes.
//
// Money rules kept here: nothing billable starts before an Approve tap (filmQueue only starts shots whose approval key
// matches their cost key); a shot whose start may have reached the provider ('unknown') needs a fresh approval; global
// Stop never touches filming; a reload never starts anything new (boot only polls ops it finds in rx:ops).
import * as R from './remix.js?v=67';
import { cutsFrom } from './remix-cuts.js?v=67';
import { advanceShot, shotRequest, firstFrameShape } from './remix-shots.js?v=67';
import { buildGraph } from './remix-graph.js?v=67';
import { createRemixStore, keys as rxKeys, SOURCE_MAX } from './remix-store.js?v=67';
import { cardThumb, padFrameAt, grabFrame, canvasToDataUrl, ensureFonts, makeCanvas, composeFrame } from './remix-draw.js?v=67';
import { frameAt as graphFrameAt } from './remix-graph.js?v=67';
import { videoParts, planFor, noteFor, fmtDur } from './video.js?v=67';

export const PLACEHOLDER = 'How should we remix it?'; // one line on a 360 px phone (the composer note and chips carry the rest)
export const COPY = Object.freeze({
  empty: 'Tell Atelier what to change — or tap Ask about it',
  cantCut: 'Can’t cut this video in this browser — export it as MP4 (H.264) or open Atelier in Chrome',
  hdr: 'HDR video will look flat when cut — export as SDR for best colour',
  checking: 'Checking the video for editing',
  choose: 'Choose Revise or New clip first',
  stop: 'Shots already started still finish at the provider and are billed',
  paused: 'Paused while Atelier was in the background — continuing',
  testerKeepOpen: 'Keep Atelier open while it films (1–6 min). If it’s closed for more than 15 min, the full reserve is charged.',
  free: 'Cards, text, covers, previews and cutting are free.',
});
export const FOOTAGE_CHOICES = Object.freeze(['ask', 'off', 8, 12, 24]);
export const PLAN_EST_USD = 0.03; // a Gemini Flash watch of a ≤ 1 min clip (the cost card says ≈)
export const REVISE_EST_USD = 0.005;
const STATUS_HZ = 250; // ms between in-place status writes (≤ 4 Hz)
const LIVE = new Set(['starting', 'filming', 'downloading']);
const TERMINAL = new Set(['ready', 'failed', 'filtered', 'budget', 'unknown', 'expired', 'missing']);
const SAFE_IMG = /^data:image\/(png|jpe?g|webp);base64,[a-z\d+/=]+$/i;
const CUT_SRC = /^data:video\/mp4;base64,[a-z\d+/=]+$/i;
// A finished cut up to this size also goes into e.media (the Library; owner media sync uploads it like a Veo clip).
// Bigger cuts stay in rx:cut only: a data URL that size would be copied on every thread save (phones).
export const LIBRARY_MAX = 16 * 1024 * 1024; // a cut is stored as a data: URL in its thread (copied on every save): keep phones light
const toDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
const ESC = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─────────────────────────── small pure helpers (exported for tests) ───────────────────────────
/** 24.5 → '0:24.5'; whole seconds keep one decimal. */
export function fmtT(t) {
  const s = Math.max(0, Number(t) || 0), m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}
const fmtLen = (s) => `${Math.round(s * 10) / 10} s`;
export const footageLabel = (c) => (c === 'ask' ? 'Only if I ask' : c === 'off' ? 'Off' : `up to ${c} s`);
/** The next footage choice when the chip is tapped. */
export const nextFootage = (c) => FOOTAGE_CHOICES[(FOOTAGE_CHOICES.indexOf(c) + 1) % FOOTAGE_CHOICES.length];
/** Shot models this account may pick (testers: only tester:true; the owner also Runway when it's set up). */
export function shotChoices({ tester = false, runway = false } = {}) {
  return R.SHOT_MODELS.filter((m) => (tester ? m.tester : m.provider !== 'runway' || runway));
}
/** Output frame rate: the source's when it is 24, 25 or 30; 50/60 halve; anything else 30. */
export function fpsFor(src) {
  const f = Math.round(Number(src) || 30);
  if ([24, 25, 30].includes(f)) return f;
  if (f === 50 || f === 60) return f / 2;
  return 30;
}
/** The composer note while a clip is attached in Video mode with remix on. */
export function composerNote(v, probe) {
  if (!v) return '';
  if (v.clipOnly || probe?.info?.canDecode === false || probe?.status === 'error') return COPY.cantCut;
  if (v.status === 'reading' && v.total) return `Reading video · ${v.done || 0} of ${v.total} frames`;
  if (!probe || probe.status === 'reading') return COPY.checking;
  const up = v.clip?.state === 'uploading' ? `Remix · uploading for Gemini · ${Math.round((v.clip.progress || 0) * 100)}%` : null;
  const base = up || `Remix · Gemini watches & hears it · ${probe.caps?.path === 'none' ? 'plan only (this browser can’t cut)' : 'fast cut'}`;
  return probe.info?.hdr ? `${base} · ${COPY.hdr}` : base;
}
/** Key of what a paint shows; unchanged → only the status text is patched. */
export function paintKey(e, extra = '') {
  const r = e?.remix || {};
  const shots = Object.entries(r.shots || {}).map(([id, s]) => `${id}:${s.state}:${s.enabled === false ? 0 : 1}:${s.blobKey ? 1 : 0}:${s.poster ? 1 : 0}`).join(',');
  return [r.phase, r.rev || 0, shots, r.export ? r.export.at : 0, e.pending ? 1 : 0, e.error ? 1 : 0, r.renderError ? 1 : 0, r.needSource ? 1 : 0, Object.keys(r.assets || {}).join('.'), extra].join('|');
}
/** Story rows for the review: one per timeline beat → [{id, n, type, title, sub, drift, shot?, issues}]. */
export function storyRows(r) {
  const plan = r?.plan;
  if (!plan) return [];
  const lay = R.layout(plan, r.source || {});
  const byId = new Map(lay.items.map((it) => [it.id, it]));
  const issues = (r.issues || []).filter((i) => i.id);
  const scenes = plan.scenes || [];
  const sceneAt = (t) => scenes.find((s) => t >= s.start - 1e-6 && t < s.end - 1e-6);
  return plan.timeline.map((c, i) => {
    const it = byId.get(c.id) || {}, len = it.outEnd - it.outStart;
    let title, sub;
    if (c.type === 'source') {
      title = `Keep ${sceneAt(c.src_in)?.label || 'footage'}`;
      sub = `${fmtT(c.src_in)}–${fmtT(c.src_out)}`;
    } else if (c.type === 'card') {
      const words = c.lines?.map((l) => l.text).join(' · ');
      title = words ? `Card · ${words}` : c.backdrop?.kind === 'frame' ? 'Hold the frame' : 'Card';
      sub = fmtLen(len);
    } else {
      const s = plan.shots.find((x) => x.id === c.shot);
      title = `New shot · ${s?.prompt ? s.prompt.slice(0, 80) : c.shot}`;
      sub = `uses ${fmtLen(len)} of ${s?.seconds ?? '?'} s`;
    }
    const drift = c.type === 'source' && Math.abs(it.drift || 0) >= 0.05 ? it.drift : 0;
    return { id: c.id, n: String(i + 1).padStart(2, '0'), type: c.type, title, sub, drift, shot: c.type === 'shot' ? c.shot : null, issues: issues.filter((x) => x.id === c.id || (c.type === 'shot' && x.id === c.shot)), why: c.why || '' };
  });
}
/** Whether an issue list stops Approve/Cut. */
export const blocked = (r) => (r?.issues || []).some((i) => i.level === 'block' || i.level === 'asset');
/** The shot chip's words and the actions it offers. */
export function shotChip(s, now = Date.now()) {
  const t = s?.state;
  if (t === 'idle') return { text: 'Waiting for approval', acts: [] };
  if (t === 'queued') return { text: 'Queued — the provider is busy, retrying (not billed)', acts: [] };
  if (t === 'starting') return { text: 'Starting…', acts: [] };
  if (t === 'filming') {
    const sec = s.startedAt ? Math.max(0, Math.round((now - s.startedAt) / 1000)) : 0;
    return { text: `Filming · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${s.progress ? ` · ${Math.round(s.progress * 100)}%` : ''}`, acts: [] };
  }
  if (t === 'downloading') return { text: 'Downloading', acts: [] };
  if (t === 'ready') return { text: 'Ready', acts: ['play'] };
  if (t === 'filtered') return { text: 'Filtered — not billed', acts: ['edit', 'retry', 'card'] };
  if (t === 'budget') return { text: `Doesn’t fit today${s.resetsAt ? ` · resets ${new Date(s.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`, acts: ['card'] };
  if (t === 'unknown') return { text: 'Couldn’t confirm the provider started this shot — retrying may bill twice', acts: ['retry-anyway', 'card'] };
  if (t === 'expired') return { text: 'The provider no longer has this shot', acts: ['refilm', 'card'] };
  if (t === 'missing') return { text: 'This shot isn’t on this device', acts: ['refilm', 'card'] };
  // a failed poll or download of a shot the provider already made: Retry collects it (free); refilming needs approval
  if (R.resumeOf(s)) return { text: s?.error || 'Couldn’t collect the shot', acts: ['retry', 'refilm', 'card'] };
  return { text: s?.error || 'The shot couldn’t be made', acts: ['retry', 'card'] };
}

// ─────────────────────────── the controller ───────────────────────────
/**
 * deps (from app.js; see remix-integration.md A17):
 *   S, DB, persist, repaint, toast, esc, btn, ICON, uid, errorBox, renderOptions, paintChip, shake, inputValue,
 *   addEntry(e) (push + render + run a new entry in the open thread), streamChat, completeChat, modelFor, providerOf,
 *   ensureClip, videoFiles, clipJobs, apiHeaders, noteAllowance, openViewer, setMode, run, liveThreads, entryById,
 *   threadIsOpen, runwayReady(), ApiError, holdSync(entryId) → release (Sync.holdRunLock: no sync push while filming/cutting)
 * test/env overrides: store, loadRender (→ the remix-render module), fetch, now, setTimeout, clearTimeout, document,
 *   navigator, URL, draw (remix-draw functions: {cardThumb, padFrameAt, grabFrame, canvasToDataUrl, ensureFonts}).
 */
export function createRemix(deps) {
  const S = deps.S;
  const esc = deps.esc || ESC;
  const now = deps.now || (() => Date.now());
  const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout || ((t) => clearTimeout(t));
  const doc = deps.document === undefined ? globalThis.document : deps.document;
  const nav = deps.navigator || globalThis.navigator;
  const URLs = deps.URL || globalThis.URL;
  const draw = { cardThumb, padFrameAt, grabFrame, canvasToDataUrl, ensureFonts, makeCanvas, composeFrame, ...(deps.draw || {}) };
  const store = deps.store || createRemixStore(deps.DB, { now });
  const toast = deps.toast || (() => {});
  const ApiError = deps.ApiError || class extends Error { constructor(status, msg) { super(msg); this.status = status; } };
  let renderMod = null;
  const loadRender = () => (renderMod ||= (deps.loadRender ? Promise.resolve(deps.loadRender()) : import('./remix-render.js?v=67')).catch((err) => { renderMod = null; throw err; }));

  const probes = new WeakMap(); // composer video → {status, info, caps, error}
  const files = new Map(); // entryId → source File (this session)
  const analyses = new Map(); // entryId → Promise<cuts | null>
  // While an entry films or cuts, owner thread sync never pushes it (half-written shot states stay on this device):
  // deps.holdSync(entryId) is Sync.holdRunLock → a release function. Held while jobs or renders has the entry.
  const held = new Map(); // entryId → release()
  const relock = (id) => {
    const want = jobs.has(id) || renders.has(id), h = held.get(id);
    if (want && !h) { let rel = null; try { rel = deps.holdSync?.(id); } catch {} held.set(id, typeof rel === 'function' ? rel : () => {}); }
    else if (!want && h) { held.delete(id); try { h(); } catch {} }
  };
  class HeldMap extends Map { set(k, v) { super.set(k, v); relock(k); return this; } delete(k) { const r = super.delete(k); relock(k); return r; } }
  const jobs = new HeldMap(); // entryId → {threadId, timer, busy, stopped, forget}
  const renders = new HeldMap(); // entryId → {ctrl, preview, paused, fraction, etaMs}
  const cutUrls = new Map(); // entryId → blob: URL of the finished cut
  const cutAway = new Set(); // entryIds whose finished cut isn't on this device (session only: never written to the entry)
  const shotUrls = new Map(); // blobKey → blob: URL (check phase players)
  const local = new Map(); // blobKey → true | false (is the blob on this device)
  const thumbs = new Map(); // `${entry}:${id}` → data URL
  const choices = new Map(); // threadId → {entryId, choice: 'revise' | 'new'}
  const composerOpts = { footage: 'ask', model: R.DEFAULT_SHOT_MODEL, keep: true };
  const statusAt = new Map(); // entryId → last status write (ms)

  const tester = () => Boolean(S?.tester);
  // Remix is the owner's (Labs); a tester only with an explicit features.remix (app.js remixOn). A remix that reached a
  // tester some other way (a backup import) can be looked at and cut, never planned or filmed.
  const filmAllowed = () => !S?.tester || S.tester.features?.remix === true;
  let wiped = false; // Clear this device: nothing is written to rx:* after it
  const remixEntries = (thread) => (thread?.entries || []).filter((x) => x.remix && !x.error);

  // ── entries outside the open thread ──
  const threadOf = (e) => (S?.thread?.entries?.includes(e) ? S.thread.id : [...(deps.liveThreads?.values?.() || [])].find((t) => t.entries?.includes(e))?.id || S?.thread?.id || null);
  async function patchEntry(threadId, entryId, fn) {
    const live = deps.entryById?.(entryId);
    if (live?.remix) {
      fn(live);
      if (S?.thread?.entries?.includes(live)) deps.persist?.(true);
      else { const t = deps.liveThreads?.get(threadId); if (t) await deps.DB?.put?.(t).catch?.(() => {}); }
      if (deps.threadIsOpen?.(threadId) !== false) deps.repaint?.(live);
      return live;
    }
    const t = threadId ? await deps.DB?.get?.(threadId) : null;
    const e = t?.entries?.find((x) => x.id === entryId);
    if (!e?.remix) return null;
    fn(e);
    await deps.DB.put(t);
    return e;
  }
  const setStatus = (e, text, force = false) => {
    e.status = text;
    const t = now();
    if (!force && t - (statusAt.get(e.id) || 0) < STATUS_HZ) return;
    statusAt.set(e.id, t);
    const el = doc?.querySelector?.(`.entry[data-id="${cssId(e.id)}"] [data-rx-status]`);
    if (el) el.textContent = text;
  };
  const cssId = (id) => String(id).replace(/["\\]/g, '');

  // ── source file ──
  // The entry whose rx:src holds the File (a revision reuses its original's); an unsafe id from an import is ignored.
  const srcOf = (e) => (/^[\w-]{1,120}$/.test(e?.remix?.srcEntry || '') ? e.remix.srcEntry : e.id);
  async function sourceFile(e) {
    const own = files.get(e.id) || deps.videoFiles?.get(e.id)?.file;
    if (own) return own;
    const srcEntry = srcOf(e);
    const other = files.get(srcEntry) || deps.videoFiles?.get(srcEntry)?.file;
    if (other) return other;
    try { const b = await store.getBlob(rxKeys.src(srcEntry)); if (b) { files.set(srcEntry, b); return b; } } catch {}
    return null;
  }
  function analyse(e, file) {
    if (analyses.has(e.id)) return analyses.get(e.id);
    const p = loadRender().then((m) => m.analyseSource(file)).then((a) => cutsFrom({ luma: a.luma, hist: a.hist, fps: a.fps, keyframes: a.keyframes })).catch((err) => { console.warn('[atelier] remix analyse', err); return null; });
    analyses.set(e.id, p);
    return p;
  }
  const within = (p, ms) => Promise.race([p, new Promise((res) => setT(() => res(null), ms))]);

  // ─────────── composer ───────────
  const composer = {
    placeholder: PLACEHOLDER,
    /** A clip was attached in Video mode: read its codec, size, rotation, HDR and whether it decodes (no spend). */
    attached(v) {
      if (!v?.file || probes.has(v)) return;
      const p = { status: 'reading', info: null, caps: null, error: null };
      probes.set(v, p);
      loadRender().then(async (m) => {
        const info = await m.probeSource(v.file);
        const caps = await m.capabilities({ out: R.outputSize(info, m.platformOf?.() || 'desktop'), kbps: R.targetKbps(info), fps: fpsFor(info.fps) });
        Object.assign(p, { status: 'ready', info, caps });
      }).catch((err) => { Object.assign(p, { status: 'error', error: String(err?.message || err) }); })
        .finally(() => { deps.paintChip?.(); deps.renderOptions?.(); });
    },
    note: (v) => composerNote(v, probes.get(v)),
    probe: (v) => probes.get(v) || null,
    /** The Video options strip while a clip is attached. */
    options() {
      const t = tester();
      const models = shotChoices({ tester: t, runway: Boolean(deps.runwayReady?.()) });
      if (!models.some((m) => m.id === composerOpts.model)) composerOpts.model = models[0]?.id || R.DEFAULT_SHOT_MODEL;
      const m = R.shotModel(composerOpts.model);
      const noVeo = t && S?.tester?.features?.video === false;
      const q = deps.inputValue && R.looksLikeQuestion(deps.inputValue()) ? '<button class="chip" data-ask-about>Ask about it instead</button>' : '';
      return `<div class="rx-opts">${q}`
        + (noVeo ? '<span class="opt-note keep">New footage: Off (not in your plan)</span>'
          : `<button class="chip" data-rx-opt="footage" aria-label="New footage: ${esc(footageLabel(composerOpts.footage))} (tap to change)">New footage: ${esc(footageLabel(composerOpts.footage))} ▾</button>`
          + (composerOpts.footage === 'off' ? '' : `<button class="chip" data-rx-opt="model">New shots: ${esc(m?.label || 'Veo')} ▾</button>`))
        + `<button class="chip${composerOpts.keep ? ' on' : ''}" data-rx-opt="keep" aria-pressed="${composerOpts.keep}">♪ Keep soundtrack</button>`
        + `<span class="opt-note keep">You approve the plan and any cost before filming · ${t ? 'planning reserves ≤ $0.11' : `planning ≈ ${Math.round(PLAN_EST_USD * 100)}¢`}</span>`
        + (q ? '' : '<button class="chip" data-ask-about>Ask about it</button>') + '</div>';
    },
    /** Video mode, no clip, a thread with a remix: Revise or New clip, never a silent paid clip. → html | ''. */
    choiceChips(thread) {
      const last = remixEntries(thread).at(-1);
      if (!last) return '';
      const c = choices.get(thread.id);
      const title = last.remix.plan?.title || last.remix.source?.name || 'the remix';
      return `<div class="rx-opts rx-choice" role="group" aria-label="What Send does">`
        + `<button class="chip${c?.choice === 'revise' ? ' on' : ''}" data-rx-choice="revise" data-entry="${esc(last.id)}" aria-pressed="${c?.choice === 'revise'}"><span aria-hidden="true">✂</span> Revise ‘${esc(title.slice(0, 40))}’</button>`
        + `<button class="chip${c?.choice === 'new' ? ' on' : ''}" data-rx-choice="new" data-entry="${esc(last.id)}" aria-pressed="${c?.choice === 'new'}"><span aria-hidden="true">✦</span> New clip</button></div>`;
    },
    /** A tap in the options strip. → true when it was a remix control. */
    onOption(target) {
      const opt = target?.closest?.('[data-rx-opt]')?.dataset.rxOpt;
      const ch = target?.closest?.('[data-rx-choice]');
      if (opt === 'footage') composerOpts.footage = nextFootage(composerOpts.footage);
      else if (opt === 'model') {
        const list = shotChoices({ tester: tester(), runway: Boolean(deps.runwayReady?.()) });
        const i = list.findIndex((m) => m.id === composerOpts.model);
        composerOpts.model = list[(i + 1) % list.length]?.id || R.DEFAULT_SHOT_MODEL;
      } else if (opt === 'keep') composerOpts.keep = !composerOpts.keep;
      else if (ch && S?.thread) choices.set(S.thread.id, { entryId: ch.dataset.entry, choice: ch.dataset.rxChoice });
      else return false;
      deps.renderOptions?.();
      return true;
    },
    /** Before a remix send. → 'ok' | 'empty' | 'held'. */
    async gate(text, video) {
      if (!String(text || '').trim()) { deps.shake?.(); toast(COPY.empty); return 'empty'; }
      const p = probes.get(video);
      if (video?.clipOnly || p?.info?.canDecode === false || p?.status === 'error') { toast(COPY.cantCut, { error: true }); return 'held'; }
      return 'ok';
    },
    /** Video mode, no clip: → null (film a new clip), 'hold' (choose first), or {revise: true, entry}. */
    textChoice(text, thread) {
      const last = remixEntries(thread).at(-1);
      if (!last) return null;
      const c = choices.get(thread.id);
      const target = c && thread.entries.find((x) => x.id === c.entryId && x.remix);
      if (!c || !target) { toast(COPY.choose); deps.renderOptions?.(); return 'hold'; }
      return c.choice === 'revise' ? { revise: true, entry: target } : null;
    },
    opts: composerOpts,
  };

  // ─────────── a new remix ───────────
  function newRemix(video, text) {
    const p = probes.get(video), info = p?.info || {};
    const footage = composerOpts.footage;
    return {
      v: R.REMIX_V, phase: 'plan', rev: 0,
      source: {
        name: video?.name || info.name || 'video', size: video?.size || info.size || 0,
        duration: info.duration || video?.duration || 0, width: info.width || video?.width || 0, height: info.height || video?.height || 0,
        fps: info.fps || 30, rotation: info.rotation || 0, vcodec: info.vcodec || null, vkbps: info.vkbps || null,
        audio: info.audio ?? null, hdr: Boolean(info.hdr), stored: false,
      },
      opts: { footage, maxNew: R.footageCap(footage, text), model: composerOpts.model, res: '720p', fit: 'adjacent', audioMode: composerOpts.keep ? 'keep' : 'follow_cuts', shotModels: {} },
      cuts: null, plan: null, issues: [], shots: {}, assets: {}, approval: null, spent: { planUsd: 0 }, export: null,
    };
  }
  /** The source File belongs to the entry: kept in kv so a reload can still cut (size-capped). */
  function keepSource(e, file) {
    if (!file || !e?.remix) return;
    files.set(e.id, file);
    const cap = tester() ? SOURCE_MAX.tester : SOURCE_MAX.owner;
    if (file.size > cap || wiped) return;
    store.putBlob(rxKeys.src(e.id), file, { threadId: S?.thread?.id }).then(() => { e.remix.source.stored = true; }).catch((err) => console.warn('[atelier] remix source', err));
    analyse(e, file); // free and local: runs while Gemini watches
  }

  // ─────────── planning ───────────
  // What normalizePlan needs to know about this browser. Read once (a Fine-tune tap would otherwise ask the encoder
  // again each time); a failed or slow read is not kept, so the next plan edit asks again.
  let capsKept = null;
  async function caps() {
    if (capsKept) return capsKept;
    const mobile = /android|iphone|ipad/i.test(nav?.userAgent || '');
    let aacEncode = null;
    try { const m = await loadRender(); aacEncode = (await within(m.capabilities({}), 4000))?.aacEncode ?? null; } catch {}
    const c = { mobile, ...(aacEncode === false ? { aacEncode: false } : {}) };
    if (aacEncode != null) capsKept = c;
    return c;
  }
  async function streamPlan(e, { messages, role = 'watch', signal, extra, label }) {
    const fin = { raw: '', finish: null, model: null };
    let lastBeat = 0;
    await deps.streamChat({
      role, model: deps.modelFor(role), max_tokens: 8000, temperature: 0.4, signal, messages, ...(extra ? { extra } : {}),
      onModel: (m) => { fin.model = m; },
      onRestart: () => { fin.raw = ''; fin.finish = null; },
      onDelta: (d) => {
        fin.raw += d.content || '';
        if (d.finish) fin.finish = d.finish;
        if (now() - lastBeat >= STATUS_HZ) { lastBeat = now(); { const n = R.beatsSoFar(fin.raw); setStatus(e, `${label} · ${n} beat${n === 1 ? '' : 's'}`); } }
      },
    });
    return fin;
  }
  async function settleInto(e, res, { prevShots = {}, model, note, cuts, spentKey, spentUsd }) {
    const r = e.remix;
    const raw = { ...res.plan, audio: { ...(res.plan.audio || {}), mode: r.opts.audioMode || 'keep' } }; // the user's soundtrack choice wins
    const c = await caps();
    const s = R.settlePlan(raw, { source: r.source, opts: { ...r.opts, assets: r.assets || {} }, caps: c, cuts });
    if (!s.plan) throw new ApiError(502, R.PLAN_ERROR);
    e.remix = {
      ...r, plan: s.plan, cuts: cuts || r.cuts || null, issues: [...(res.issues || []), ...s.issues].slice(0, 100),
      shots: R.initShots(s.plan, r.opts, prevShots), phase: 'review', planAt: now(), rev: (r.rev || 0) + 1, approval: null, // a new plan: any spend needs a new tap
      truncated: res.truncated || undefined, spent: { ...(r.spent || {}), [spentKey]: (Number(r.spent?.[spentKey]) || 0) + spentUsd },
    };
    e.meta = { ...(e.meta || {}), model: model || e.meta?.model, note };
    store.draftSave(e.id, draftOf(e)).catch(() => {});
  }
  const draftOf = (e) => ({ plan: e.remix.plan, shots: e.remix.shots, opts: e.remix.opts, assets: e.remix.assets, rev: e.remix.rev, threadId: threadOf(e) }); // threadId: a deleted thread's drafts go with it
  function parseRepaired(raw) {
    const p = R.parsePlan(raw, 'stop');
    return p.plan && !p.needs && !p.issues.length ? p.plan : null;
  }
  /** A remix entry's run (app.js run() → here): Gemini watches the clip and returns the plan. */
  async function plan(e, signal, thread) {
    const r = e.remix;
    if (!r) throw new Error('Not a remix');
    if (!filmAllowed()) throw new ApiError(403, 'Video Remix isn’t part of your Atelier plan.');
    if (r.reviseOf) return planRevise(e, signal, thread);
    setStatus(e, 'Getting the clip ready', true);
    const file = await sourceFile(e);
    const cutsP = file ? analyse(e, file) : Promise.resolve(r.cuts || null);
    const v = e.video || {};
    const got = deps.ensureClip ? await deps.ensureClip(e, e, signal, thread) : { file: null };
    const clip = got?.file || null;
    if (!clip && !v.frames?.length) throw new ApiError(got?.error?.status || 502, 'Gemini couldn’t get the clip to plan this remix — tap Try again (Atelier needs to upload it).');
    const ctx = { source: r.source, maxNew: r.opts.maxNew, fit: r.opts.fit, audioMode: r.opts.audioMode };
    const plans = new Map();
    const messages = (compact) => (m) => {
      const p = planFor(v, deps.providerOf(m), clip);
      if (!p) return null;
      plans.set(m, p);
      return [{ role: 'system', content: R.remixSystem({ ...ctx, compact }) }, { role: 'user', content: R.remixUser(e.prompt, videoParts(v, p)) }];
    };
    setStatus(e, clip ? 'Watching & listening' : 'Looking at the frames', true);
    let fin = await streamPlan(e, { messages: messages(false), signal, label: 'Laying out the edit' });
    let res = R.parsePlan(fin.raw, fin.finish || 'stop');
    if (res.needs === 'compact') {
      setStatus(e, 'The plan ran long — asking for a shorter one', true);
      fin = await streamPlan(e, { messages: messages(true), signal, extra: { reasoning_effort: 'low' }, label: 'Laying out a shorter edit' });
      res = R.parsePlan(fin.raw, fin.finish || 'stop');
      if (res.needs === 'compact') res = { plan: null, issues: [], needs: null };
    }
    if (res.needs === 'repair') {
      setStatus(e, 'Tidying the plan', true);
      try {
        const fixed = parseRepaired(await deps.completeChat({ role: 'fast', model: deps.modelFor('fast'), messages: R.repairMessages(fin.raw), signal, max_tokens: 8000, temperature: 0 }));
        if (fixed && R.repairAccepts(fin.raw, fixed)) res = { plan: fixed, issues: [] };
      } catch (err) { if (err?.name === 'AbortError') throw err; }
    }
    if (!res.plan) throw new ApiError(502, R.PLAN_ERROR);
    setStatus(e, 'Finding scene changes', true);
    const cuts = await within(cutsP, 20000);
    const p = plans.get(fin.model) || [...plans.values()].at(-1);
    await settleInto(e, res, { model: fin.model, note: `remix · ${noteFor(p).replace(/^video · /, '')}`, cuts, spentKey: 'planUsd', spentUsd: PLAN_EST_USD });
  }
  async function planRevise(e, signal) {
    const r = e.remix;
    const base = deps.entryById?.(r.reviseOf);
    const prev = base?.remix?.plan || r.basePlan;
    if (!prev) throw new ApiError(409, 'The remix this revises isn’t here any more — attach the video again to start over.');
    const ctx = { source: r.source, maxNew: r.opts.maxNew, fit: r.opts.fit, audioMode: r.opts.audioMode };
    setStatus(e, 'Revising the plan', true);
    const fin = await streamPlan(e, { role: 'ask', signal, label: 'Revising the edit', messages: [{ role: 'system', content: R.reviseSystem(ctx) }, { role: 'user', content: R.reviseUser(prev, e.prompt) }] });
    const res = R.parsePlan(fin.raw, fin.finish || 'stop');
    if (!res.plan) throw new ApiError(502, R.PLAN_ERROR);
    delete r.basePlan;
    await settleInto(e, res, { prevShots: base?.remix?.shots || {}, model: fin.model, note: 'remix · revised plan (no re-upload)', cuts: r.cuts, spentKey: 'reviseUsd', spentUsd: REVISE_EST_USD });
  }
  /** A text-only revision of e: a new entry that reuses e's source, cuts, assets and every unchanged paid shot. */
  function revise(e, text) {
    if (!e?.remix || !deps.addEntry) return null;
    const t = String(text || '').trim();
    if (!t) { deps.shake?.(); toast('Say what to change, then send'); return null; }
    const r = e.remix;
    // A revision copies the shots; one still filming would be collected only into this entry, never the revision.
    if (jobs.has(e.id) || shotsLive(r.shots)) { toast('Let the new shots finish filming, then revise'); return null; }
    const ne = {
      id: deps.uid ? deps.uid() : `${now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      kind: 'video', prompt: t, images: [], createdAt: now(), pending: true, params: e.params ? structuredClone(e.params) : {},
      ...(e.video ? { video: e.video } : {}), remixOf: e.id,
      remix: {
        v: R.REMIX_V, phase: 'plan', rev: 0, reviseOf: e.id, srcEntry: srcOf(e), basePlan: r.plan,
        source: { ...r.source }, opts: { ...r.opts }, cuts: r.cuts || null, plan: null, issues: [], shots: {},
        assets: { ...(r.assets || {}) }, approval: null, spent: { planUsd: 0 }, export: null,
      },
    };
    deps.addEntry(ne);
    return ne;
  }

  // ─────────── plan edits (Fine-tune) ───────────
  /** mutate(plan) on a copy → normalised again (no re-snap, no auto-fit: the user's times stay); fit: run fitLocked. */
  async function editPlan(e, mutate, { fit = false } = {}) {
    const r = e.remix;
    const plan = structuredClone(r.plan);
    mutate(plan);
    const c = await caps();
    const shotModels = Object.fromEntries(Object.entries(r.shots || {}).map(([id, s]) => [id, { model: s.model, res: s.res }]));
    const n = R.normalizePlan(plan, r.source, { ...r.opts, shotModels, assets: r.assets || {} }, c);
    if (!n.plan) { toast('That change would leave nothing to cut', { error: true }); return; }
    let next = n.plan, extra = [];
    const D = Number(r.source?.duration) || 0, fps = Number(r.source?.fps) || 30;
    if (fit) { const f = R.fitLocked(next, D, next.audio.fit, fps); next = f.plan; extra = f.issues; }
    const lay = R.layout(next, r.source);
    const syncLeft = next.audio.mode === 'keep' && D ? lay.duration - D : 0;
    const sync = Math.abs(syncLeft) > 1 / fps + 1e-6 ? [{ level: 'block', id: null, msg: `Picture is ${Math.abs(Math.round(syncLeft * 10) / 10)} s ${syncLeft > 0 ? 'longer' : 'shorter'} than the soundtrack — tap Fit` }] : [];
    const shots = R.initShots(next, { model: r.opts.model, res: r.opts.res }, r.shots);
    e.remix = { ...r, plan: next, shots, issues: [...n.issues.filter((i) => i.level !== 'fix'), ...extra, ...R.syncIssues(next, lay), ...sync].slice(0, 100), rev: (r.rev || 0) + 1 };
    if (r.phase === 'done' || r.phase === 'check') e.remix.phase = 'review';
    store.draftSave(e.id, draftOf(e)).catch(() => {});
    deps.persist?.();
    deps.repaint?.(e);
  }
  /** The picture's and the soundtrack's lengths for the sync line. */
  function syncLine(r) {
    const lay = R.layout(r.plan, r.source), D = Number(r.source?.duration) || 0;
    if ((r.plan.audio?.mode || 'keep') !== 'keep' || !D) return { ok: true, text: `Picture ${fmtLen(lay.duration)} · audio follows the cuts` };
    const d = lay.duration - D;
    return Math.abs(d) <= 1 / (Number(r.source.fps) || 30) + 1e-6
      ? { ok: true, text: `Picture ${fmtLen(lay.duration)} · Soundtrack ${fmtLen(D)} · in sync` }
      : { ok: false, text: `Picture is ${fmtLen(Math.abs(d))} ${d > 0 ? 'longer' : 'shorter'} than the soundtrack` };
  }

  // ─────────── approval and filming ───────────
  function approve(e) {
    const r = e.remix;
    if (!filmAllowed()) { toast('Video Remix isn’t part of your Atelier plan — nothing was filmed', { error: true }); return false; }
    if (blocked(r)) { toast('Fix the highlighted beats first', { error: true }); return false; }
    const cost = R.planCost(r, { tester: S?.tester || null });
    if (!cost.canApprove) {
      toast(cost.tester ? 'That’s more than your allowance has left today — skip a shot or use a card' : 'One of the shots can’t be filmed with its model', { error: true });
      return false;
    }
    const toFilm = Object.entries(r.shots || {}).filter(([, s]) => s.enabled !== false && !['ready', ...LIVE].includes(s.state));
    if (!toFilm.length) { r.phase = 'check'; deps.persist?.(); deps.repaint?.(e); return true; }
    // Each reset also goes to the job store (a tick merges that store over the entry): a shot the provider already made
    // is collected again for free (resumeOf); anything else that ended goes back to idle under this new approval.
    const resets = {};
    for (const [id, s] of toFilm) {
      const resume = R.resumeOf(s);
      if (resume) { s.state = resume; delete s.error; resets[id] = { state: resume, error: undefined, tries: undefined }; }
      else if (['unknown', 'failed', 'filtered', 'expired', 'missing', 'budget'].includes(s.state)) {
        s.state = 'idle'; for (const k of ['error', 'op', 'uri', 'tries']) delete s[k];
        resets[id] = { state: 'idle', error: undefined, op: undefined, uri: undefined, tries: undefined };
      }
    }
    r.approval = R.approvalFor(r, null, now());
    r.phase = 'film';
    deps.persist?.(true);
    deps.repaint?.(e);
    startJob(e.id, S?.thread?.id || null, resets);
    return true;
  }
  /** resets: {shotId: patch} a tap made to the entry, written to the job store before the next tick reads it. */
  function startJob(entryId, threadId, resets = {}) {
    if (wiped) return null;
    let job = jobs.get(entryId);
    if (!job) jobs.set(entryId, (job = { threadId, timer: null, busy: false, stopped: false, forget: false, resets: {} }));
    if (threadId && !job.threadId) job.threadId = threadId;
    job.resets = { ...(job.resets || {}), ...resets };
    job.stopped = false; // an Approve or Retry tap: new starts are allowed again (boot resumes with stopped = true)
    schedule(entryId, 0);
    return job;
  }
  function schedule(entryId, ms) {
    const job = jobs.get(entryId);
    if (!job) return;
    if (job.timer) clearT(job.timer);
    job.timer = setT(() => { job.timer = null; tick(entryId).catch((err) => console.warn('[atelier] remix film', err)); }, Math.max(0, ms));
  }
  async function loadEntry(threadId, entryId) {
    const live = deps.entryById?.(entryId);
    if (live?.remix) return live;
    const t = threadId ? await deps.DB?.get?.(threadId) : null;
    return t?.entries?.find((x) => x.id === entryId && x.remix) || null;
  }
  /** One shot's patch: job store first (the source of truth), then the thread entry, then the op index. */
  async function applyShot(entryId, shotId, patch, extra = {}) {
    if (wiped) return null; // Clear this device: a request still in flight writes nothing back
    const job = jobs.get(entryId);
    const threadId = job?.threadId ?? extra.threadId ?? null;
    await store.jobPatch(entryId, shotId, patch, threadId ?? undefined);
    if (patch.state === 'starting' || patch.state === 'filming' || patch.state === 'downloading') {
      await store.opsAdd({ entryId, threadId, shotId, op: patch.op ?? extra.op ?? null, startedAt: patch.startedAt || now(), model: extra.model, seconds: extra.seconds, res: extra.res, tester: tester() });
    } else if (TERMINAL.has(patch.state)) await store.opsRemove(entryId, shotId);
    const e = await patchEntry(threadId, entryId, (x) => {
      const s = x.remix.shots?.[shotId];
      if (!s) return;
      Object.assign(s, patch);
      for (const [k, v] of Object.entries(s)) if (v === null || v === undefined) delete s[k];
    });
    return e;
  }
  const shotsLive = (shots) => Object.values(shots || {}).some((s) => s.enabled !== false && LIVE.has(s.state));
  async function tick(entryId) {
    const job = jobs.get(entryId);
    if (!job || job.busy || wiped) return;
    job.busy = true;
    let again = null;
    try {
      const e = await loadEntry(job.threadId, entryId);
      if (!e) { jobs.delete(entryId); return; }
      const r = e.remix;
      const resets = Object.entries(job.resets || {});
      job.resets = {};
      for (const [id, p] of resets) { const x = r.shots?.[id]; if (x) await applyShot(entryId, id, p, { op: x.op, model: x.model, seconds: x.seconds, res: x.res }); }
      const rec = await store.jobGet(entryId);
      for (const [id, s] of Object.entries(rec?.shots || {})) if (r.shots?.[id]) { const { at, ...rest } = s; void at; Object.assign(r.shots[id], rest); }
      const t = now();
      const startIds = job.stopped || job.forget || r.phase !== 'film' || !filmAllowed() ? [] : R.filmQueue(r, { tester: tester(), now: t });
      const liveIds = Object.entries(r.shots || {}).filter(([, s]) => s.enabled !== false && (s.state === 'filming' || s.state === 'downloading')).map(([id]) => id);
      for (const id of [...liveIds, ...startIds]) {
        const s = r.shots[id];
        const starting = s.state === 'idle' || s.state === 'queued';
        const step = async () => {
          if (wiped) return;
          if (starting) {
            // Another tab may have started this shot since the merge above: the job store (shared IndexedDB) is read
            // again inside the cross-tab start lock, and only a shot still idle (or queued) there is started.
            const cur = (await store.jobGet(entryId))?.shots?.[id];
            if (cur && !['idle', 'queued'].includes(cur.state)) { const { at, ...rest } = cur; void at; Object.assign(s, rest); return; }
          }
          let request;
          if (starting) {
            const planShot = r.plan?.shots?.find((x) => x.id === id);
            try { request = await requestFor(e, id, planShot, s); }
            catch (err) { await applyShot(entryId, id, { state: 'failed', error: String(err?.message || err).slice(0, 300) }); return; }
          }
          const patch = await advanceShot({
            fetch: deps.fetch, apiHeaders: deps.apiHeaders, onResponse: deps.noteAllowance, now,
            save: (p) => applyShot(entryId, id, p, { op: s.op, model: s.model, seconds: s.seconds, res: s.res }),
            putBlob: (blob) => (wiped ? Promise.resolve({ bytes: blob.size }) : store.putBlob(rxKeys.shot(entryId, id), blob, { threadId: job.threadId })),
            request,
          }, { ...s });
          if (patch && !wiped) {
            await applyShot(entryId, id, patch, { op: s.op, model: s.model, seconds: s.seconds, res: s.res });
            if (patch.state === 'ready') posterFor(entryId, id).catch(() => {});
          }
        };
        await (starting ? startLock(entryId, step) : step());
      }
      // what next
      const after = (await loadEntry(job.threadId, entryId))?.remix || r;
      const shots = Object.entries(after.shots || {}).filter(([, s]) => s.enabled !== false);
      if (after.phase === 'film' && shots.length && shots.every(([, s]) => s.state === 'ready')) {
        await patchEntry(job.threadId, entryId, (x) => { x.remix.phase = 'check'; });
        if (!deps.threadIsOpen?.(job.threadId)) toast(`Shots ready for “${after.plan?.title || 'your remix'}” — open the thread to cut it`);
      }
      const queuedAt = shots.filter(([, s]) => s.state === 'queued').map(([, s]) => Number(s.retryAt) || t + 30_000);
      const startable = !job.stopped && !job.forget && filmAllowed() && after.phase === 'film' && R.filmQueue(after, { tester: tester(), now: now() }).length > 0;
      if (shotsLive(after.shots) || startable) {
        const oldest = Math.min(...shots.filter(([, s]) => LIVE.has(s.state)).map(([, s]) => Number(s.startedAt) || t), t);
        again = startable ? 500 : t - oldest > 180_000 ? 10_000 : 5_000;
      } else if (queuedAt.length) again = Math.max(1000, Math.min(...queuedAt) - now());
      else {
        jobs.delete(entryId);
        if (job.forget) await store.dropEntry(entryId);
      }
    } finally {
      job.busy = false;
      if (again != null && jobs.get(entryId) === job) schedule(entryId, again);
    }
  }
  /** Web Locks (shared by every tab of this origin) around a start; without them the re-read in tick still narrows it. */
  function startLock(entryId, fn) {
    const locks = nav?.locks;
    return typeof locks?.request === 'function' ? locks.request(`atelier-rx-start:${entryId}`, fn) : fn();
  }
  /** The provider request for a shot: its first frame (when the plan starts from one) is padded from the source. */
  async function requestFor(e, id, planShot, s) {
    if (!planShot) throw new Error('This shot isn’t in the plan any more.');
    const r = e.remix;
    const out = R.outputSize(r.source, 'desktop');
    let image = null;
    if (planShot.first_frame != null) {
      const file = await sourceFile(e);
      if (file && doc) {
        try { image = await draw.padFrameAt(file, planShot.first_frame, firstFrameShape(s.model, out)); } catch (err) { console.warn('[atelier] first frame', err); }
      }
      if (!image && R.shotModel(s.model)?.image === 'required') throw new Error('This shot starts from a frame of the original video — attach it again to film it.');
    }
    return shotRequest(planShot, { model: s.model, res: s.res, seconds: s.seconds, look: r.plan?.style?.look || '', image, out });
  }
  /** A ready shot's poster (a small JPEG of its first second) for the chip. Browser only. */
  async function posterFor(entryId, id) {
    if (!doc) return;
    const blob = await store.getBlob(rxKeys.shot(entryId, id));
    if (!blob) return;
    const c = await draw.grabFrame(blob, 0.5, { maxEdge: 200 });
    const poster = await draw.canvasToDataUrl(c, 0.7);
    if (typeof poster === 'string' && poster.length <= 60_000 && SAFE_IMG.test(poster)) await applyShot(entryId, id, { poster });
  }
  function stopCollecting(e) {
    const job = jobs.get(e.id);
    if (job) { if (job.timer) clearT(job.timer); jobs.delete(e.id); }
    for (const [id, s] of Object.entries(e.remix.shots || {})) {
      if (LIVE.has(s.state) || s.state === 'queued') applyShot(e.id, id, { state: 'failed', error: `Stopped collecting — ${COPY.stop.toLowerCase()}` }).catch(() => {});
    }
    toast(COPY.stop);
  }
  /** Retry one shot: failed/filtered/expired/missing go back to idle under the same approval; unknown needs a new one. */
  function retryShot(e, id, { anyway = false } = {}) {
    const r = e.remix, s = r.shots?.[id];
    if (!s || wiped) return;
    if (!filmAllowed()) { toast('Video Remix isn’t part of your Atelier plan — nothing was filmed', { error: true }); return; }
    if (s.state === 'unknown' || anyway) {
      s.state = 'idle'; for (const k of ['error', 'op', 'uri', 'tries']) delete s[k];
      if (r.approval?.keys) { r.approval = { ...r.approval, keys: { ...r.approval.keys } }; delete r.approval.keys[id]; }
      r.phase = 'review';
      store.jobPatch(e.id, id, { state: 'idle', error: undefined, op: undefined, uri: undefined, tries: undefined }).catch(() => {});
      deps.persist?.(); deps.repaint?.(e);
      toast('Approve again to film it — the earlier start may still bill');
      return;
    }
    // Already made at the provider (a poll or download failed): collect it again — free, never a second generation.
    const resume = R.resumeOf(s);
    if (resume) {
      s.state = resume; delete s.error; delete s.tries;
      r.phase = 'film'; deps.persist?.(); deps.repaint?.(e);
      startJob(e.id, threadOf(e), { [id]: { state: resume, error: undefined, tries: undefined } });
      return;
    }
    s.state = 'idle'; for (const k of ['error', 'op', 'uri', 'tries']) delete s[k];
    const reset = { state: 'idle', error: undefined, op: undefined, uri: undefined, tries: undefined };
    if (r.approval?.keys?.[id] === R.costKey(s)) { r.phase = 'film'; deps.persist?.(); deps.repaint?.(e); startJob(e.id, threadOf(e), { [id]: reset }); }
    else { store.jobPatch(e.id, id, reset).catch(() => {}); r.phase = 'review'; deps.persist?.(); deps.repaint?.(e); }
  }
  /** Replace every use of a shot with a card of the same length over a blurred still. */
  function cardInstead(e, shotId) {
    return editPlan(e, (plan) => {
      let prevOut = 0;
      plan.timeline = plan.timeline.map((c) => {
        if (c.type === 'source') prevOut = c.src_out;
        if (c.type !== 'shot' || c.shot !== shotId) return c;
        return { id: c.id, type: 'card', seconds: Math.max(0.5, Math.round((c.use_out - c.use_in) * 1000) / 1000), backdrop: { kind: 'frame_blur', t: prevOut }, lines: [], motion: 'push', enter: c.enter, why: 'A card instead of the new shot' };
      });
      plan.overlays = (plan.overlays || []).filter((o) => plan.timeline.some((c) => c.id === o.clip && c.type !== 'card'));
      plan.shots = plan.shots.filter((s) => s.id !== shotId);
    });
  }

  // ─────────── the cut ───────────
  async function cut(e, { preview = false } = {}) {
    const r = e.remix;
    if (doc?.hidden) return;
    if (renders.has(e.id)) return;
    if (blocked(r)) { toast('Fix the highlighted beats first', { error: true }); return; }
    const file = await sourceFile(e);
    if (!file) { r.needSource = true; deps.repaint?.(e); return; }
    delete r.needSource; delete r.renderError;
    const ctrl = new AbortController();
    const threadId = threadOf(e); // the user may switch threads while it cuts
    const job = { ctrl, preview, paused: false, fraction: 0, etaMs: null, prevPhase: r.phase };
    renders.set(e.id, job);
    if (!preview) { r.phase = 'cut'; deps.repaint?.(e); }
    else toast('Rendering a quick preview…');
    try {
      const m = await loadRender();
      const platform = m.platformOf?.() || 'desktop';
      const full = R.outputSize(r.source, platform);
      const out = preview ? { w: Math.round(full.w / 4) * 2, h: Math.round(full.h / 4) * 2 } : full;
      const fps = preview ? 15 : fpsFor(r.source.fps);
      const kbps = preview ? 1200 : R.targetKbps(r.source);
      const cap = await m.capabilities({ out, kbps, fps });
      if (cap.path === 'none') throw Object.assign(new Error(cap.reason), { code: 'unsupported' });
      const shots = {}, sizes = {};
      for (const [id, s] of Object.entries(r.shots || {})) {
        if (s.enabled === false || !r.plan.timeline.some((c) => c.type === 'shot' && c.shot === id)) continue;
        const blob = s.blobKey ? await store.getBlob(s.blobKey) : null;
        if (!blob) throw Object.assign(new Error(`Shot ${id} isn’t on this device — refilm it or use a card.`), { code: 'missing' });
        shots[id] = blob;
        try { const info = await m.probeSource(blob); sizes[id] = { width: info.width, height: info.height }; } catch {}
      }
      const images = {};
      for (const o of r.plan.overlays || []) {
        if (o.kind !== 'image' || o.asset !== 'needed') continue;
        const a = r.assets?.[o.id];
        const blob = a?.blobKey ? await store.getBlob(a.blobKey) : null;
        if (!blob) throw Object.assign(new Error(`Add the screenshot for “${o.hint || 'this beat'}” first.`), { code: 'asset' });
        images[o.id] = await globalThis.createImageBitmap(blob);
      }
      const shotSeconds = Object.fromEntries(Object.entries(r.shots || {}).map(([id, s]) => [id, s.seconds]));
      const lay = R.layout(r.plan, r.source, { shotSeconds });
      const g = buildGraph(lay, r.plan, { fps, out, source: r.source, shots: sizes });
      const fonts = await draw.ensureFonts(r.plan);
      if (fonts === 'fallback' && !preview) toast('Studio fonts didn’t load — cards will use Georgia');
      const res = await m.renderCut({
        file, graph: g, shots, images, codec: cap.h264, kbps, preview, signal: ctrl.signal, env: { webkit: cap.webkit },
        onProgress: (p) => { job.fraction = p.fraction; job.etaMs = p.etaMs; setStatus(e, cutStatus(job)); },
      });
      if (preview) {
        const url = URLs.createObjectURL(res.blob);
        deps.openViewer?.({ title: 'Preview · half size', video: url });
        return res;
      }
      await store.putBlob(rxKeys.cut(e.id), res.blob, { threadId });
      const old = cutUrls.get(e.id); if (old) URLs.revokeObjectURL?.(old);
      cutUrls.set(e.id, URLs.createObjectURL(res.blob));
      cutAway.delete(e.id);
      r.export = { path: res.path, mime: res.mime, bytes: res.bytes, w: res.w, h: res.h, fps: res.fps, seconds: res.seconds, kbps: res.kbps, at: now(), fonts, ...(res.poster && SAFE_IMG.test(res.poster) && res.poster.length < 120_000 ? { poster: res.poster } : {}) };
      r.phase = 'done';
      // The Library lists e.media: a cut that isn't too big joins it (and outlives rx:cut's 7-day prune).
      if (res.blob.size <= LIBRARY_MAX && typeof FileReader === 'function') {
        try { const src = await toDataUrl(res.blob); if (CUT_SRC.test(src)) e.media = [{ type: 'video', src, ...(r.export.poster ? { still: r.export.poster } : {}) }]; } catch {}
      } else delete e.media; // an earlier, smaller cut must not stand in for this one
      e.meta = { ...(e.meta || {}), note: `remix · ${fmtLen(res.seconds)} · ${res.w}×${res.h} · H.264${res.audio === 'copy' ? ' + original audio' : res.audio === 'mix' ? ' + cut audio' : ''}` };
      return res;
    } catch (err) {
      if (err?.name === 'AbortError') { if (!job.paused && !preview) r.phase = job.prevPhase; }
      else {
        console.warn('[atelier] remix cut', err);
        if (!preview) r.phase = job.prevPhase === 'cut' ? 'check' : job.prevPhase;
        r.renderError = String(err?.message || err).slice(0, 300);
        if (preview) toast(r.renderError, { error: true });
      }
      return null;
    } finally {
      if (renders.get(e.id) === job && !job.paused) renders.delete(e.id);
      if (S?.thread?.entries?.includes(e)) deps.persist?.();
      else if (threadId && !preview) await patchEntry(threadId, e.id, (x) => { if (x === e) return; x.remix = e.remix; x.meta = e.meta; if (e.media) x.media = e.media; else delete x.media; }).catch(() => {});
      deps.repaint?.(e);
    }
  }
  const cutStatus = (job) => `Cutting · ${Math.round((job.fraction || 0) * 100)}%${job.etaMs != null ? ` · about ${fmtDur(Math.max(1, Math.round(job.etaMs / 1000))) || `${Math.round(job.etaMs / 1000)} s`} left` : ''}`;
  function cancelCut(e) { const j = renders.get(e.id); if (j) { j.paused = false; j.ctrl.abort(); } }
  // Hidden mid-cut: stop (WebCodecs throttles in the background) and start again from frame 0 when visible — free.
  function onVisibility() {
    if (!doc) return;
    if (doc.hidden) {
      for (const [id, j] of renders) if (!j.preview) { j.paused = true; j.ctrl.abort(); setStatus({ id }, COPY.paused, true); }
    } else {
      for (const [id, j] of [...renders]) {
        if (!j.paused) continue;
        renders.delete(id);
        const e = deps.entryById?.(id);
        if (e?.remix) { e.remix.phase = j.prevPhase; toast(COPY.paused); cut(e); }
      }
    }
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);
  globalThis.addEventListener?.('pagehide', () => { if (!wiped) store.draftFlush().catch(() => {}); });

  // rx:cut first; once that is pruned (7 days), the Library copy in e.media (a checked data URL — never a remote URL).
  const mediaCut = (e) => { const src = e.media?.[0]?.type === 'video' ? e.media[0].src : null; return typeof src === 'string' && CUT_SRC.test(src) ? src : null; };
  async function cutBlob(e) {
    const b = await store.getBlob(rxKeys.cut(e.id)).catch(() => null);
    if (b) return b;
    const src = mediaCut(e);
    if (!src) return null;
    try { const bin = atob(src.slice(src.indexOf(',') + 1)); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Blob([u8], { type: 'video/mp4' }); } catch { return null; }
  }
  async function cutUrl(e) {
    if (cutUrls.has(e.id)) return cutUrls.get(e.id);
    const b = await cutBlob(e);
    if (!b) return null;
    const u = URLs.createObjectURL(b);
    cutUrls.set(e.id, u);
    return u;
  }
  async function saveCut(e) {
    const url = await cutUrl(e);
    if (!url || !doc) { toast('The cut isn’t on this device any more — cut it again (free)', { error: true }); return; }
    const a = doc.createElement('a');
    a.href = url; a.download = `${(e.remix.plan?.title || 'remix').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'remix'}.mp4`;
    doc.body.append(a); a.click(); a.remove();
  }
  async function shareCut(e) {
    const b = await cutBlob(e);
    if (!b) { toast('The cut isn’t on this device any more — cut it again (free)', { error: true }); return; }
    const f = new File([b], `${(e.remix.plan?.title || 'remix').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'remix'}.mp4`, { type: 'video/mp4' });
    if (nav?.canShare?.({ files: [f] })) { try { await nav.share({ files: [f], title: e.remix.plan?.title || 'Remix' }); } catch {} }
    else saveCut(e);
  }
  function planJson(e) {
    if (!doc) return;
    const url = URLs.createObjectURL(new Blob([JSON.stringify(e.remix.plan, null, 2)], { type: 'application/json' }));
    const a = doc.createElement('a'); a.href = url; a.download = 'remix-plan.json'; doc.body.append(a); a.click(); a.remove();
    setT(() => URLs.revokeObjectURL?.(url), 5000);
  }
  /** Attach the original again (source missing) or a screenshot for an image layer — through a file picker. */
  function pickFile(accept) {
    return new Promise((res) => {
      if (!doc) return res(null);
      const i = doc.createElement('input');
      i.type = 'file'; i.accept = accept;
      i.onchange = () => res(i.files?.[0] || null);
      i.click();
    });
  }
  async function attachSource(e) {
    const f = await pickFile('video/*');
    if (!f) return;
    const s = e.remix.source || {};
    if ((s.size && Math.abs(f.size - s.size) > 1024) || (s.name && f.name && f.name !== s.name)) toast(`That isn’t quite the original (${s.name || 'video'}) — cutting anyway`);
    files.set(srcOf(e), f);
    const cap = tester() ? SOURCE_MAX.tester : SOURCE_MAX.owner;
    if (f.size <= cap) store.putBlob(rxKeys.src(srcOf(e)), f, { threadId: S?.thread?.id }).catch(() => {});
    delete e.remix.needSource;
    deps.repaint?.(e);
  }
  async function attachImage(e, layerId) {
    const f = await pickFile('image/png,image/jpeg,image/webp');
    if (!f) return;
    const blobKey = rxKeys.img(e.id, layerId);
    const { bytes } = await store.putBlob(blobKey, f, { threadId: S?.thread?.id });
    let w = 0, h = 0, thumb;
    try {
      const bmp = await globalThis.createImageBitmap(f);
      w = bmp.width; h = bmp.height;
      const k = Math.min(1, 160 / Math.max(w, h)), c = draw.makeCanvas(w * k, h * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const d = await draw.canvasToDataUrl(c, 0.7);
      if (SAFE_IMG.test(d) && d.length < 60_000) thumb = d;
    } catch {}
    e.remix.assets = { ...(e.remix.assets || {}), [layerId]: { blobKey, w, h, bytes, ...(thumb ? { thumb } : {}) } };
    e.remix.issues = (e.remix.issues || []).filter((i) => !(i.level === 'asset' && i.id === layerId));
    e.remix.rev = (e.remix.rev || 0) + 1;
    deps.persist?.(); deps.repaint?.(e);
  }

  // ─────────── painting ───────────
  const metaSeen = new WeakMap();
  function paint(li, e, meta = '') {
    const out = li.querySelector('.out'), acts = li.querySelector('.actions');
    if (!out) return;
    const job = renders.get(e.id);
    const away = Object.values(e.remix?.shots || {}).filter((s) => s.blobKey && local.get(s.blobKey) === false).length;
    const key = paintKey(e, `${job ? (job.preview ? 'p' : 'c') : ''}${away}${jobs.has(e.id) ? 'j' : ''}${cutAway.has(e.id) ? 'a' : ''}`);
    if (out.dataset.rxKey === key && metaSeen.get(out) === meta) {
      const st = out.querySelector('[data-rx-status]');
      if (st && e.status && st.textContent !== e.status) st.textContent = e.status;
      if (acts) acts.innerHTML = actsHtml(e);
      return;
    }
    out.dataset.rxKey = key; metaSeen.set(out, meta);
    li.classList.add('rx-entry');
    li.setAttribute?.('aria-busy', e.pending ? 'true' : 'false');
    let body;
    try { body = bodyHtml(e); } catch (err) {
      // a plan this build can't read (validRemix guards imports and sync; this guards everything else): the rest of the
      // thread still paints
      console.warn('[atelier] remix paint', err);
      out.innerHTML = `${meta}<p class="rx-note">This remix can’t be shown in this version of Atelier.</p>`;
      if (acts) acts.innerHTML = '';
      return;
    }
    out.innerHTML = meta + body;
    if (acts) acts.innerHTML = actsHtml(e);
    hydrate(out, e);
  }
  const statusHtml = (text, e) => `<span class="status rx-status"><span class="shimmer" data-rx-status>${esc(text)}</span>${e?.startedAt ? `<span class="tick" data-since="${e.startedAt}" aria-hidden="true"></span>` : ''}</span>`;
  function bodyHtml(e) {
    const r = e.remix;
    const ratio = r.source?.width && r.source?.height ? `${r.source.width}/${r.source.height}` : '4/5';
    if (e.pending) return `<div class="rx-pending" style="aspect-ratio:${ratio}">${statusHtml(e.status || 'Watching & listening', e)}</div>`;
    if (e.error) return deps.errorBox ? deps.errorBox(e) : `<p class="rx-error">${esc(e.error)}</p>`;
    if (!r.plan) return `<p class="rx-note">The plan didn’t arrive — tap Try again.</p>`;
    const job = renders.get(e.id);
    let h = '';
    if (r.phase === 'cut' || (job && !job.preview)) h += `<div class="rx-cutting" role="status">${statusHtml(job ? cutStatus(job) : 'Cutting', null)}<button class="chip" data-act="rx-cancel-cut">Cancel</button></div>`;
    if (r.phase === 'done' && cutAway.has(e.id)) h += `<div class="rx-callout"><p>The finished cut isn’t on this device — cut it again here (free).</p><button class="chip" data-act="rx-cut">Cut it · free</button></div>`;
    else if (r.phase === 'done') h += doneHtml(e);
    h += storyHtml(e);
    if (r.needSource) h += `<div class="rx-callout"><p>Attach the original video again to finish the cut — ${esc(r.source?.name || 'video')} · ${esc(fmtDur(r.source?.duration) || '')}${r.source?.size ? ` · ${(r.source.size / 1048576).toFixed(1)} MB` : ''}</p><button class="chip" data-act="rx-attach-source">Attach</button></div>`;
    if (r.renderError) h += `<div class="rx-callout bad"><p>${esc(r.renderError)}</p><button class="chip" data-act="rx-cut">Try again</button><button class="chip" data-act="rx-plan-json">Download plan (.json)</button></div>`;
    // 'film' with no job here and no shot live (the tab closed between Approve and the first start, or every shot
    // ended): offer the review card again — Approve or Retry is a tap; nothing restarts by itself.
    const filming = r.phase === 'film' && (jobs.has(e.id) || shotsLive(r.shots));
    if (r.phase === 'review' || (r.phase === 'film' && !filming)) h += costHtml(e);
    if (filming) h += `<p class="rx-film">${statusHtml(filmStatus(r), null)}</p><p class="rx-note">${tester() ? esc(COPY.testerKeepOpen) : 'You can leave — Atelier collects the shots when you’re back.'}</p>`;
    if (r.phase === 'check') h += `<div class="rx-cost"><p class="rx-cost-head">Ready to cut</p><p class="rx-note">${esc(COPY.free)}</p><div class="rx-cost-acts"><button class="rx-primary" data-act="rx-cut">Cut it · free</button><button class="chip" data-act="rx-preview">Preview · free</button></div></div>`;
    return h;
  }
  const filmStatus = (r) => {
    const all = Object.values(r.shots || {}).filter((s) => s.enabled !== false);
    const done = all.filter((s) => s.state === 'ready').length;
    const prov = all.some((s) => R.shotModel(s.model)?.provider === 'runway') ? 'Runway' : 'Veo';
    return `Filming ${Math.min(all.length, done + 1)} of ${all.length} with ${prov} · usually 1–6 min`;
  };
  function storyHtml(e) {
    const r = e.remix, plan = r.plan;
    const rows = storyRows(r);
    const general = (r.issues || []).filter((i) => !i.id && i.level !== 'fix');
    const fixes = (r.issues || []).filter((i) => i.level === 'fix');
    let h = `<section class="rx-story"><h3 class="rx-title">${esc(plan.title)}</h3>${plan.summary ? `<p class="rx-summary">${esc(plan.summary)}</p>` : ''}`;
    if (general.length) h += `<ul class="rx-issues">${general.map((i) => `<li class="rx-issue ${esc(i.level)}">${esc(i.msg)}</li>`).join('')}</ul>`;
    h += '<ol class="rx-beats">';
    for (const row of rows) {
      const s = row.shot ? r.shots?.[row.shot] : null;
      const thumbKey = `${e.id}:${row.id}`;
      h += `<li class="rx-beat rx-${esc(row.type)}" data-id="${esc(row.id)}"><button class="rx-thumb" data-act="rx-frame" data-id="${esc(row.id)}" aria-label="See beat ${row.n}">${thumbs.has(thumbKey) ? `<img src="${esc(thumbs.get(thumbKey))}" alt="" />` : '<span class="rx-thumb-ph" aria-hidden="true"></span>'}</button>`
        + `<div class="rx-beat-text"><p class="rx-beat-title"><span class="rx-n">${row.n}</span>${esc(row.title)}</p><p class="rx-beat-sub">${esc(row.sub)}${row.drift ? ` · plays ${Math.abs(Math.round(row.drift * 10) / 10)} s ${row.drift > 0 ? 'after' : 'before'} its sound` : ''}</p>`;
      for (const i of row.issues) h += `<p class="rx-issue ${esc(i.level)}">${esc(i.msg)}</p>`;
      if (s) h += shotHtml(e, row.shot, s);
      h += '</div></li>';
    }
    h += '</ol>';
    // image layers that need a screenshot
    for (const o of plan.overlays || []) {
      if (o.kind !== 'image' || o.asset !== 'needed') continue;
      const a = r.assets?.[o.id];
      h += `<div class="rx-asset"><p>${a ? `Screenshot added${a.thumb && SAFE_IMG.test(a.thumb) ? ` <img src="${esc(a.thumb)}" alt="" />` : ''}` : `Add a screenshot: ${esc(o.hint || 'the screen this beat needs')}`}</p><button class="chip" data-act="rx-attach-image" data-id="${esc(o.id)}">${a ? 'Replace' : 'Add'}</button><button class="chip" data-act="rx-remove-layer" data-id="${esc(o.id)}">Remove</button></div>`;
    }
    if (fixes.length) h += `<details class="rx-fixes"><summary>${fixes.length} adjustment${fixes.length === 1 ? '' : 's'} Atelier made</summary><ul>${fixes.map((i) => `<li>${esc(i.msg)}</li>`).join('')}</ul></details>`;
    return `${h}</section>`;
  }
  function shotHtml(e, id, s) {
    // Synced from another device: its bytes and its op live there (only ops in THIS device's rx:ops are polled).
    const away = s.state === 'ready' && s.blobKey && local.get(s.blobKey) === false;
    const elsewhere = LIVE.has(s.state) && !jobs.has(e.id);
    const c = away ? shotChip({ state: 'missing' }) : elsewhere ? { text: 'Filming on another device', acts: ['card'] } : shotChip(s, now());
    const poster = s.poster && SAFE_IMG.test(s.poster) ? `<img class="rx-poster" src="${esc(s.poster)}" alt="" />` : '';
    const chip = `<span class="rx-chip rx-${esc(s.state)}">${poster}${esc(c.text)}</span>`;
    const act = (a, label) => `<button class="chip" data-act="${a}" data-id="${esc(id)}">${esc(label)}</button>`;
    const price = R.formatUsd(R.shotUsd(s.model, s.seconds, s.res) ?? 0);
    const acts = c.acts.map((a) => (a === 'play' ? act('rx-play-shot', 'Play ▶') : a === 'edit' ? act('rx-finetune', 'Edit prompt') : a === 'retry' ? act('rx-retry-shot', 'Retry') : a === 'retry-anyway' ? act('rx-retry-anyway', 'Retry anyway · needs approval') : a === 'refilm' ? act('rx-retry-anyway', `Refilm · ${price}`) : act('rx-card-instead', 'Use a card'))).join('');
    const changed = s.state === 'ready' && s.filmedKey && s.contentKey && s.filmedKey !== s.contentKey
      ? `<p class="rx-issue warn">Changed since filming</p>${act('rx-keep-footage', 'Keep current footage')}${act('rx-retry-anyway', `Refilm · ${price} · needs approval`)}` : '';
    const unknownOwner = s.state === 'unknown' && !tester() && R.shotModel(s.model)?.provider === 'veo' ? '<a class="chip" href="https://aistudio.google.com/usage" target="_blank" rel="noopener">Check usage in AI Studio</a>' : '';
    return `<div class="rx-shot" data-shot="${esc(id)}">${chip}${acts}${unknownOwner}${changed}</div>`;
  }
  function costHtml(e) {
    const r = e.remix;
    const cost = R.planCost(r, { tester: S?.tester || null });
    const total = R.runningTotal(r);
    const lines = cost.lines.map((l) => {
      const m = R.shotModel(l.model);
      return `<li>New footage · ${esc(l.id)} · ${esc(l.seconds)} s · ${esc(m?.label || l.model)} · ${esc(l.res)}${l.ok ? '' : l.why === 'cap' ? ' · over the per-shot cap' : ' · not in your plan'}</li>`;
    }).join('');
    const block = blocked(r);
    const shotsToFilm = cost.lines.length > 0;
    let money = '';
    if (shotsToFilm && !cost.tester) money = `<p class="rx-price">≈ ${R.formatUsd(cost.usd)} · billed by the provider per generated second. Failed or filtered shots aren’t billed.</p>`;
    if (shotsToFilm && cost.tester) money = `<p class="rx-price">Reserves ${R.formatUsd(cost.reserve / 1e6)} of ${R.formatUsd((cost.room || 0) / 1e6)} left ${esc(cost.scope || 'today')} · settles at ≈ ${R.formatUsd(cost.usd)}</p><p class="rx-note">${esc(COPY.testerKeepOpen)}</p>`;
    const primary = shotsToFilm ? `Approve &amp; film · ${R.formatUsd(cost.usd)}` : 'Cut it · free';
    const sync = syncLine(r);
    return `<div class="rx-cost" role="group" aria-label="Ready to cut"><p class="rx-cost-head">Ready to cut</p>`
      + `<p class="rx-sync${sync.ok ? '' : ' off'}">${esc(sync.text)}${sync.ok ? '' : ' <button class="chip" data-act="rx-fit">Fit</button>'}</p>`
      + (lines ? `<ul class="rx-lines">${lines}</ul>` : '') + money
      + `<p class="rx-note">${esc(total.text)}</p><p class="rx-note">${esc(COPY.free)}</p>`
      + `<div class="rx-cost-acts"><button class="rx-primary" data-act="${shotsToFilm ? 'rx-approve' : 'rx-cut'}"${block || (shotsToFilm && !cost.canApprove) ? ' disabled' : ''}>${primary}</button>`
      + `<button class="chip" data-act="rx-preview"${shotsToFilm ? ' disabled title="Preview after the shots are filmed"' : ''}>Preview · free</button><button class="chip" data-act="rx-finetune">Fine-tune</button><button class="chip ghost" data-act="rx-revise">Revise with Gemini…</button></div></div>`;
  }
  function doneHtml(e) {
    const r = e.remix, x = r.export || {};
    const poster = x.poster && SAFE_IMG.test(x.poster) ? ` poster="${esc(x.poster)}"` : '';
    return `<figure class="rx-cut" style="aspect-ratio:${x.w || 4}/${x.h || 5}"><video data-rx-cut controls playsinline preload="metadata"${poster}></video></figure>`
      + `<div class="rx-done-acts"><button class="rx-primary" data-act="rx-save">Save MP4${x.bytes ? ` · ${Math.max(1, Math.round(x.bytes / 1048576))} MB` : ''}</button><button class="chip" data-act="rx-share">Share…</button><button class="chip" data-act="rx-edit-plan">Edit plan</button><button class="chip ghost" data-act="rx-revise">Revise with Gemini…</button></div>`
      + (x.mime === 'video/webm' ? '<p class="rx-note">WebM — convert before posting to iPhone/Instagram</p>' : '');
  }
  function actsHtml(e) {
    if (e.pending || !e.remix?.plan) return '';
    return deps.btn ? deps.btn('rx-revise', deps.ICON?.pen || '', 'Revise') : '';
  }
  /** After a paint: the cut's video src, beat thumbnails, and whether shot bytes are on this device. */
  function hydrate(out, e) {
    const r = e.remix;
    const vid = out.querySelector('[data-rx-cut]');
    // A cut made on another device (or pruned here): say so on this device only — rewriting e.remix would sync back.
    if (vid) cutUrl(e).then((u) => { if (u) vid.src = u; else if (!cutAway.has(e.id)) { cutAway.add(e.id); deps.repaint?.(e); } });
    if (r.plan && doc) thumbsFor(e).catch(() => {});
    for (const [id, s] of Object.entries(r.shots || {})) {
      if (s.state !== 'ready' || !s.blobKey || local.has(s.blobKey)) continue;
      store.getBlob(s.blobKey).then((b) => { local.set(s.blobKey, Boolean(b)); if (!b) deps.repaint?.(e); }).catch(() => {});
      void id;
    }
  }
  let thumbQueue = Promise.resolve();
  // A thumbnail is patched into the painted story in place: a repaint is keyed (paintKey) and would skip it.
  function fillThumb(e, id, url) {
    const b = doc?.querySelector?.(`.entry[data-id="${cssId(e.id)}"] .rx-thumb[data-id="${cssId(id)}"]`);
    if (!b || b.querySelector('img') || typeof url !== 'string' || !SAFE_IMG.test(url)) return;
    const img = doc.createElement('img'); img.src = url; img.alt = ''; b.replaceChildren(img);
  }
  function thumbsFor(e) {
    thumbQueue = thumbQueue.then(async () => {
      const r = e.remix;
      const lay = R.layout(r.plan, r.source);
      const file = await sourceFile(e);
      for (const it of lay.items) {
        const key = `${e.id}:${it.id}`;
        if (thumbs.has(key)) continue;
        const c = r.plan.timeline.find((x) => x.id === it.id);
        try {
          if (it.type === 'card') {
            const bd = c.backdrop?.kind !== 'brand' && file ? await draw.grabFrame(file, c.backdrop.t, { maxEdge: 320 }) : null;
            thumbs.set(key, await draw.canvasToDataUrl(draw.cardThumb({ ...c, accent: r.plan.style?.accent }, { w: 120, backdrop: bd, accent: r.plan.style?.accent || 'lime' }), 0.72));
          } else if (it.type === 'source' && file) {
            thumbs.set(key, await draw.canvasToDataUrl(await draw.grabFrame(file, it.mediaIn + 0.05, { maxEdge: 160 }), 0.72));
          } else continue;
          fillThumb(e, it.id, thumbs.get(key));
        } catch { /* thumbnails are best-effort */ }
      }
    });
    return thumbQueue;
  }
  /** Tapping a beat thumbnail: the exact composited frame at that beat's start — no render. */
  async function openFrame(e, id) {
    const r = e.remix;
    const file = await sourceFile(e);
    if (!file) { toast('Attach the original video again to see frames', { error: true }); return; }
    const lay = R.layout(r.plan, r.source);
    const out = R.outputSize(r.source, 'desktop');
    const g = buildGraph(lay, r.plan, { fps: fpsFor(r.source.fps), out, source: r.source });
    const it = g.items.find((x) => x.id === id);
    if (!it) return;
    const k = Math.min(g.frames - 1, Math.round((it.outStart + Math.min(0.5, (it.outEnd - it.outStart) / 2)) * g.fps));
    const gf = graphFrameAt(g, k);
    const frames = {};
    for (const d of gf.draws) {
      const x = g.items.find((y) => y.id === d.id);
      if (x.type === 'source') frames[d.id] = await draw.grabFrame(file, d.media, { maxEdge: 2000 });
      else if (x.type === 'card' && x.card.backdrop.kind !== 'brand') frames[d.id] = await draw.grabFrame(file, x.card.backdrop.t, { maxEdge: 2000 });
      else if (x.type === 'shot') { const b = r.shots?.[x.shot]?.blobKey ? await store.getBlob(r.shots[x.shot].blobKey) : null; if (b) frames[d.id] = await draw.grabFrame(b, d.media, { maxEdge: 2000 }); }
    }
    // grabFrame returns upright canvases: crops are re-derived for them (rotation is already applied)
    for (const x of g.items) if (frames[x.id] && x.crop) x.crop = R.cropFor(frames[x.id].width, frames[x.id].height, g.w, g.h, 0);
    const c = draw.makeCanvas(g.w, g.h);
    draw.composeFrame(c.getContext('2d'), gf, g, { frames, images: {} }, {});
    deps.openViewer?.({ title: `Beat ${id} · ${fmtT(gf.t)}`, img: await draw.canvasToDataUrl(c, 0.9) });
  }
  async function playShot(e, id) {
    const s = e.remix.shots?.[id];
    const b = s?.blobKey ? await store.getBlob(s.blobKey) : null;
    if (!b) { toast('This shot isn’t on this device', { error: true }); return; }
    let u = shotUrls.get(s.blobKey);
    if (!u) shotUrls.set(s.blobKey, (u = URLs.createObjectURL(b)));
    deps.openViewer?.({ title: `Shot ${id}`, video: u });
  }

  // ─────────── Fine-tune sheet ───────────
  let sheet = null, sheetEntry = null;
  function openSheet(e) {
    if (!doc) return;
    sheetEntry = e;
    if (!sheet) {
      sheet = doc.createElement('dialog');
      sheet.className = 'sheet rx-sheet';
      sheet.setAttribute('aria-labelledby', 'rxSheetTitle');
      doc.body.append(sheet);
      sheet.addEventListener('click', (ev) => onSheetClick(ev).catch((err) => console.warn('[atelier] fine-tune', err)));
      sheet.addEventListener('change', (ev) => onSheetChange(ev).catch((err) => console.warn('[atelier] fine-tune', err)));
      sheet.addEventListener('close', () => { sheetEntry = null; });
    }
    renderSheet();
    if (!sheet.open) sheet.showModal?.();
  }
  function renderSheet() {
    const e = sheetEntry;
    if (!sheet || !e?.remix?.plan) return;
    const focus = doc.activeElement && sheet.contains(doc.activeElement) ? doc.activeElement.dataset.key : null;
    const openRows = new Set([...sheet.querySelectorAll('details[open][data-id]')].map((d) => d.dataset.id));
    sheet.innerHTML = sheetHtml(e, openRows);
    if (focus) sheet.querySelector(`[data-key="${cssId(focus)}"]`)?.focus?.();
  }
  function sheetHtml(e, openRows = new Set()) {
    const r = e.remix, plan = r.plan, lay = R.layout(plan, r.source);
    const total = Math.max(0.001, lay.duration);
    const strip = lay.items.map((it) => `<span class="rx-blk rx-${esc(it.type)}" style="flex-grow:${Math.max(0.02, (it.outEnd - it.outStart) / total).toFixed(4)}" title="${esc(it.id)} · ${fmtT(it.outStart)}"></span>`).join('');
    const ticks = (lay.layers || []).map((l) => `<span class="rx-tick rx-${esc(l.kind)}" style="left:${((l.outStart / total) * 100).toFixed(2)}%;width:${(((l.outEnd - l.outStart) / total) * 100).toFixed(2)}%"></span>`).join('');
    const sync = syncLine(r);
    // Steppers keep focus across the sheet's re-render (data-key) and read as words, not field names.
    const NAMES = { src_in: 'In point', src_out: 'Out point', seconds: 'Card length', use_in: 'Shot in point', use_out: 'Shot out point' };
    const num = (id, f, v, step = 0.1) => `<span class="rx-step"><button type="button" class="chip" data-step="${f}" data-id="${esc(id)}" data-d="-${step}" data-key="${esc(id)}-${f}-dn" aria-label="${NAMES[f] || f} minus ${step} s">−</button><input type="number" inputmode="decimal" step="${step}" data-f="${f}" data-id="${esc(id)}" data-key="${esc(id)}-${f}" value="${esc(v)}" aria-label="${NAMES[f] || f} (s)" /><button type="button" class="chip" data-step="${f}" data-id="${esc(id)}" data-d="${step}" data-key="${esc(id)}-${f}-up" aria-label="${NAMES[f] || f} plus ${step} s">+</button></span>`;
    const styleSel = (id, i, cur) => `<select data-f="line-style" data-id="${esc(id)}" data-i="${i}" data-key="${esc(id)}-ls${i}">${Object.keys(R.CARD_STYLES).map((k) => `<option${k === cur ? ' selected' : ''}>${k}</option>`).join('')}</select>`;
    let rows = '';
    for (const c of plan.timeline) {
      const open = openRows.has(c.id) ? ' open' : '';
      let body = '';
      if (c.type === 'source') body = `<label class="rx-f"><span>In</span>${num(c.id, 'src_in', c.src_in)}</label><label class="rx-f"><span>Out</span>${num(c.id, 'src_out', c.src_out)}</label>`;
      else if (c.type === 'card') {
        body = `<label class="rx-f"><span>Length (s)</span>${num(c.id, 'seconds', c.seconds)}</label>`
          + (c.lines || []).map((l, i) => `<div class="rx-f rx-line"><input type="text" maxlength="120" data-f="line-text" data-id="${esc(c.id)}" data-i="${i}" data-key="${esc(c.id)}-lt${i}" value="${esc(l.text)}" aria-label="Card line ${i + 1}" />${styleSel(c.id, i, l.style)}</div>`).join('')
          + ((c.lines || []).length < R.LIMITS.cardLines ? `<button type="button" class="chip" data-add-line data-id="${esc(c.id)}">Add a line</button>` : '')
          + `<label class="rx-f"><span>Backdrop</span><select data-f="backdrop" data-id="${esc(c.id)}" data-key="${esc(c.id)}-bd">${['brand', 'frame_blur', 'frame'].map((k) => `<option value="${k}"${c.backdrop?.kind === k ? ' selected' : ''}>${k === 'brand' ? 'Studio black' : k === 'frame_blur' ? 'Blurred frame' : 'Freeze frame'}</option>`).join('')}</select></label>`
          + `<label class="rx-f rx-check"><input type="checkbox" data-f="push" data-id="${esc(c.id)}"${c.motion === 'push' ? ' checked' : ''} /> Push in</label>`;
      } else {
        const s = plan.shots.find((x) => x.id === c.shot) || {}, st = r.shots?.[c.shot] || {};
        const models = shotChoices({ tester: tester(), runway: Boolean(deps.runwayReady?.()) });
        body = `<label class="rx-f"><span>Uses (s into the shot)</span>${num(c.id, 'use_in', c.use_in)}${num(c.id, 'use_out', c.use_out)}</label>`
          + `<label class="rx-f"><span>Prompt</span><textarea rows="3" maxlength="${R.LIMITS.promptMax}" data-f="prompt" data-id="${esc(c.shot)}" data-key="${esc(c.shot)}-pr">${esc(s.prompt || '')}</textarea></label>`
          + `<label class="rx-f"><span>Camera</span><select data-f="camera" data-id="${esc(c.shot)}">${['static', 'push_in', 'pan', 'tilt', 'orbit', 'handheld'].map((k) => `<option${s.camera === k ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`
          + `<label class="rx-f"><span>Model</span><select data-f="model" data-id="${esc(c.shot)}">${models.map((m) => `<option value="${esc(m.id)}"${st.model === m.id ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>`
          + `<label class="rx-f rx-check"><input type="checkbox" data-f="skip" data-id="${esc(c.shot)}"${st.enabled === false ? ' checked' : ''} /> Skip this shot</label>`
          + `<button type="button" class="chip" data-card-instead data-id="${esc(c.shot)}">Use a card instead</button>`;
      }
      const layers = (plan.overlays || []).filter((o) => o.clip === c.id).map((o) => {
        const head = o.kind === 'text' ? `Text · ${o.lines.map((l) => l.text).join(' / ')}` : o.kind === 'cover' ? `Cover · ${o.fill}` : o.asset === 'tap' ? 'Tap' : `Screenshot · ${o.hint || ''}`;
        const edit = o.kind === 'text'
          ? o.lines.map((l, i) => `<input type="text" maxlength="120" data-f="layer-text" data-id="${esc(o.id)}" data-i="${i}" data-key="${esc(o.id)}-t${i}" value="${esc(l.text)}" aria-label="Text line ${i + 1}" />`).join('')
            + `<select data-f="position" data-id="${esc(o.id)}">${['auto', 'upper', 'center', 'lower', 'lower_third'].map((k) => `<option${o.position === k ? ' selected' : ''}>${k}</option>`).join('')}</select>`
          : o.kind === 'cover' ? `<select data-f="fill" data-id="${esc(o.id)}">${[['blur', 'Blur'], ['match', 'Match surroundings'], ['brand', 'Black']].map(([k, v]) => `<option value="${k}"${o.fill === k ? ' selected' : ''}>${v}</option>`).join('')}</select>` : '';
        return `<div class="rx-layer"><p>${esc(head.slice(0, 120))} · ${fmtT(o.from)}–${fmtT(o.to)}</p>${edit}<button type="button" class="chip" data-remove-layer data-id="${esc(o.id)}">Remove</button></div>`;
      }).join('');
      rows += `<details class="rx-row rx-${esc(c.type)}" data-id="${esc(c.id)}"${open}><summary>${esc(c.id)} · ${esc(c.type === 'source' ? 'Keep' : c.type === 'card' ? 'Card' : 'New shot')}</summary><div class="rx-row-body">${body}${layers}</div></details>`;
    }
    const issues = (r.issues || []).filter((i) => i.level !== 'fix').map((i) => `<li class="rx-issue ${esc(i.level)}">${esc(i.msg)}</li>`).join('');
    return `<div class="sheet-body rx-sheet-body"><header class="sheet-head"><h2 id="rxSheetTitle">Fine-tune</h2><button type="button" class="chip" data-close>Done</button></header>`
      + `<div class="rx-strip" aria-hidden="true"><div class="rx-blocks">${strip}</div><div class="rx-ticks">${ticks}</div></div>`
      + `<p class="rx-sync${sync.ok ? '' : ' off'}">${esc(sync.text)}${sync.ok ? '' : ' <button type="button" class="chip" data-fit>Fit</button>'}</p>`
      + (issues ? `<ul class="rx-issues">${issues}</ul>` : '')
      + `<div class="rx-rows">${rows}</div>`
      + `<footer class="sheet-foot"><button type="button" class="chip" data-preview>Preview whole cut · free</button><button type="button" class="btn-primary" data-close>Done</button></footer></div>`;
  }
  async function onSheetClick(ev) {
    const e = sheetEntry, t = ev.target;
    if (!e) return;
    if (t.closest('[data-close]')) { sheet.close(); return; }
    if (t.closest('[data-preview]')) { sheet.close(); cut(e, { preview: true }); return; }
    if (t.closest('[data-fit]')) { await editPlan(e, () => {}, { fit: true }); renderSheet(); return; }
    const step = t.closest('[data-step]');
    if (step) {
      const id = step.dataset.id, f = step.dataset.step, d = Number(step.dataset.d);
      await editPlan(e, (p) => { const c = p.timeline.find((x) => x.id === id); if (c && typeof c[f] === 'number') c[f] = Math.round((c[f] + d) * 1000) / 1000; });
      renderSheet(); return;
    }
    const rm = t.closest('[data-remove-layer]');
    if (rm) { await editPlan(e, (p) => { p.overlays = p.overlays.filter((o) => o.id !== rm.dataset.id); }); renderSheet(); return; }
    const add = t.closest('[data-add-line]');
    if (add) { await editPlan(e, (p) => { const c = p.timeline.find((x) => x.id === add.dataset.id); c?.lines.push({ text: 'New line', style: 'body' }); }); renderSheet(); return; }
    const ci = t.closest('[data-card-instead]');
    if (ci) { await cardInstead(e, ci.dataset.id); renderSheet(); }
  }
  async function onSheetChange(ev) {
    const e = sheetEntry, t = ev.target, f = t.dataset?.f, id = t.dataset?.id;
    if (!e || !f) return;
    const r = e.remix;
    if (f === 'model' || f === 'skip') {
      const s = r.shots?.[id];
      if (!s) return;
      if (f === 'skip') s.enabled = !t.checked;
      else { const m = R.shotModel(t.value); if (!m) return; s.model = m.id; s.res = m.res.includes(s.res) ? s.res : m.res[0]; r.opts.shotModels = { ...(r.opts.shotModels || {}), [id]: { model: s.model, res: s.res } }; }
      await editPlan(e, () => {});
      renderSheet(); return;
    }
    const val = t.type === 'checkbox' ? t.checked : t.value;
    await editPlan(e, (p) => {
      const c = p.timeline.find((x) => x.id === id), s = p.shots.find((x) => x.id === id), o = (p.overlays || []).find((x) => x.id === id);
      const i = Number(t.dataset.i);
      if (['src_in', 'src_out', 'seconds', 'use_in', 'use_out'].includes(f) && c) { const n = Number(val); if (Number.isFinite(n)) c[f] = n; }
      else if (f === 'line-text' && c?.lines?.[i]) { c.lines[i].text = String(val); if (!c.lines[i].text.trim()) c.lines.splice(i, 1); }
      else if (f === 'line-style' && c?.lines?.[i]) c.lines[i].style = String(val);
      else if (f === 'backdrop' && c) c.backdrop = val === 'brand' ? { kind: 'brand' } : { kind: val, t: c.backdrop?.t ?? 0 };
      else if (f === 'push' && c) c.motion = val ? 'push' : 'none';
      else if (f === 'prompt' && s) s.prompt = String(val);
      else if (f === 'camera' && s) s.camera = String(val);
      else if (f === 'layer-text' && o?.lines?.[i]) o.lines[i].text = String(val);
      else if (f === 'position' && o) o.position = String(val);
      else if (f === 'fill' && o) o.fill = String(val);
    });
    renderSheet();
  }

  // ─────────── actions ───────────
  /** A tap on a remix entry's button. → true when handled. */
  async function onAct(act, el, e) {
    if (!e?.remix) return false;
    const id = el?.dataset?.id;
    switch (act) {
      case 'retry': if (e.error || !e.remix.plan) { deps.run?.(e); return true; } if (e.remix.renderError) { cut(e); return true; } deps.run?.(e); return true;
      case 'edit-prompt': openSheet(e); return true;
      case 'rx-revise': {
        const text = deps.inputValue?.()?.trim();
        if (text) { if (revise(e, text)) deps.clearInput?.(); } else { if (S?.thread) choices.set(S.thread.id, { entryId: e.id, choice: 'revise' }); deps.setMode?.('video'); deps.renderOptions?.(); toast('Type what to change, then Send — Atelier revises this plan'); deps.focusInput?.(); }
        return true;
      }
      case 'rx-finetune': openSheet(e); return true;
      case 'rx-approve': approve(e); return true;
      case 'rx-cut': cut(e); return true;
      case 'rx-preview': cut(e, { preview: true }); return true;
      case 'rx-cancel-cut': cancelCut(e); return true;
      case 'rx-stop-collect': stopCollecting(e); return true;
      case 'rx-retry-shot': retryShot(e, id); return true;
      case 'rx-retry-anyway': retryShot(e, id, { anyway: true }); return true;
      case 'rx-card-instead': await cardInstead(e, id); return true;
      case 'rx-keep-footage': { const s = e.remix.shots?.[id]; if (s) { s.filmedKey = s.contentKey; deps.persist?.(); deps.repaint?.(e); } return true; }
      case 'rx-play-shot': playShot(e, id); return true;
      case 'rx-frame': openFrame(e, id).catch((err) => toast(String(err?.message || err), { error: true })); return true;
      case 'rx-fit': await editPlan(e, () => {}, { fit: true }); return true;
      case 'rx-save': saveCut(e); return true;
      case 'rx-share': shareCut(e); return true;
      case 'rx-edit-plan': e.remix.phase = 'review'; deps.persist?.(); deps.repaint?.(e); openSheet(e); return true;
      case 'rx-attach-source': attachSource(e); return true;
      case 'rx-attach-image': attachImage(e, id); return true;
      case 'rx-remove-layer': await editPlan(e, (p) => { p.overlays = p.overlays.filter((o) => o.id !== id); }); return true;
      case 'rx-plan-json': planJson(e); return true;
      default: return false;
    }
  }

  // ─────────── boot, threads ───────────
  /** Once at startup: resume polling every op in rx:ops (nothing new starts), settle 'starting' as 'unknown', prune. */
  async function boot() {
    const ops = await store.opsAll();
    const byEntry = new Map();
    for (const o of ops) { const l = byEntry.get(o.entryId) || []; l.push(o); byEntry.set(o.entryId, l); }
    for (const [entryId, list] of byEntry) {
      const threadId = list.find((o) => o.threadId)?.threadId || null;
      const rec = await store.jobGet(entryId);
      jobs.set(entryId, { threadId, timer: null, busy: false, stopped: false, forget: false });
      let resume = false;
      for (const [id, s] of Object.entries(rec?.shots || {})) {
        if (s.state === 'starting') await applyShot(entryId, id, { state: 'unknown', error: 'Couldn’t confirm the provider started this shot — retrying may bill twice' });
        else if (s.state === 'queued') await applyShot(entryId, id, { state: 'failed', error: 'Interrupted while the provider was busy — tap Retry (not billed)' });
        else if (s.state === 'filming' || s.state === 'downloading') {
          resume = true;
          await patchEntry(threadId, entryId, (x) => { if (x.remix.shots?.[id]) Object.assign(x.remix.shots[id], { state: s.state, op: s.op, uri: s.uri, startedAt: s.startedAt }); });
        }
      }
      // the job may only hold ops whose shots were stopped: drop stale records
      for (const o of list) if (!rec?.shots?.[o.shotId] || TERMINAL.has(rec.shots[o.shotId].state)) await store.opsRemove(entryId, o.shotId);
      // a reload never starts new shots: the entry stays in 'film' only for its live ones
      if (resume) { const job = jobs.get(entryId); job.stopped = true; schedule(entryId, 0); }
      else jobs.delete(entryId);
    }
    try {
      const live = typeof deps.DB?.keys === 'function' ? await deps.DB.keys() : null;
      await store.prune({ liveThreadIds: live, keep: [...jobs.keys()] });
    } catch (err) { console.warn('[atelier] remix prune', err); }
  }
  const cutting = () => [...renders.values()].some((j) => !j.preview);
  function activeThreads() {
    const out = new Set();
    for (const j of jobs.values()) if (j.threadId) out.add(j.threadId);
    return out;
  }
  function deleteWarning(threadId) {
    const n = [...jobs.entries()].filter(([, j]) => j.threadId === threadId).length;
    return `${n === 1 ? 'A remix is' : `${n} remixes are`} still filming at the provider (billed). Delete anyway? Atelier keeps collecting so the cost settles, then removes the shots.`;
  }
  /**
   * The thread was deleted: keep polling live shots (so a tester's reserve settles at actual), then drop the bytes;
   * every other rx:* file of that thread goes now.
   */
  async function forgetThread(threadId) {
    for (const j of jobs.values()) if (j.threadId === threadId) j.forget = true;
    choices.delete(threadId);
    if (!threadId || wiped) return;
    try { await store.dropThread(threadId, { keep: [...jobs.keys()] }); } catch (err) { console.warn('[atelier] remix forget', err); }
  }
  /** Settings → Clear this device: stop every job and cut, and write nothing to rx:* again (kvClear runs next). */
  function wipe() {
    wiped = true;
    for (const [id, j] of [...jobs]) { if (j.timer) clearT(j.timer); jobs.delete(id); }
    for (const [id, j] of [...renders]) { j.paused = false; try { j.ctrl.abort(); } catch {} renders.delete(id); }
    store.draftCancel?.();
  }

  return {
    composer, newRemix, keepSource, plan, revise, paint, onAct, boot, cutting, activeThreads, deleteWarning, forgetThread, wipe,
    // for the Fine-tune sheet, tests and the browser check
    approve, cut, editPlan, retryShot, cardInstead, stopCollecting, tick, startJob, store, _jobs: jobs, _renders: renders,
  };
}
