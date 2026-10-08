// Runway video for Video mode (owner only): the model catalogue, cost quotes, request builders, the task runner
// (create → poll every ≥ 5 s with jitter → download) and the "Use Runway?" hint. Pure helpers are node-tested
// (tests/runway-client.test.mjs); nothing touches the DOM at import time.
// The browser only ever talks to Atelier's /api/runway/* (src/runway.js), never to Runway: the key and Runway's
// signed, expiring output links stay on the server, and the finished MP4 comes back as a Blob that app.js stores
// like a Veo result (a data: URL in the thread).
// Prices: https://docs.dev.runwayml.com/guides/pricing/ (1 credit = $0.01) — re-check now and then; src/runway.js
// keeps its own copy and tests/runway-client.test.mjs checks the two agree.

export const USD_PER_CREDIT = 0.01;
export const PORTAL_URL = 'https://dev.runway.com';
export const RUNWAY_URL = 'https://runway.com';
// Runway's terms ask for this wherever its output is shown to end users; Atelier shows it to the owner too.
export const POWERED_BY = `<a class="rw-powered" href="${RUNWAY_URL}" target="_blank" rel="noopener">Powered by Runway</a>`;
export const PROMPT_MAX = 1000, DATA_URI_MAX = 5_242_880, UPLOAD_MAX = 95 * 1024 * 1024, UPLOAD_MIN = 512;
export const ALEPH_MIN_S = 2, ALEPH_MAX_S = 30;
export const I2V_RATIOS = Object.freeze(['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672']);
export const T2V_RATIOS = Object.freeze(['1280:720', '720:1280']);
// Google Veo 3.1 through Runway: these four ratios for text and image → video, 4/6/8 s (src/runway.js keeps the same).
export const VEO_RATIOS = Object.freeze(['1280:720', '720:1280', '1080:1920', '1920:1080']);
export const TARGET_ASPECTS = Object.freeze(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16', '21:9']);
export const UPLOAD_TYPES = Object.freeze(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'image/png', 'image/jpeg', 'image/webp']);
// Video-mode length menu for Runway models (Runway takes 2–10 whole seconds; Veo 3.1, on Runway too, 4/6/8).
export const RUNWAY_SECONDS = Object.freeze([2, 4, 6, 8, 10]);
export const VEO_SECONDS = Object.freeze([4, 6, 8]);
// xAI's Grok Imagine Video 1.5 / 1.5 Lite through Runway: 1–15 s (this menu), prompts up to 2,500 characters, the still
// as is (the output follows it). src/runway.js keeps the ratio lists and prices; these are the ones Video mode sends.
export const GROK_SECONDS = Object.freeze([4, 6, 8, 10, 15]);
export const GROK_PROMPT_MAX = 2500;
// ByteDance's Seedance 2.5 through Runway: 4–30 whole seconds (the Video menu offers SEEDANCE_SECONDS; Remix any whole
// length in range), prompts up to 15,000 characters, 18 ratios whose size sets the price tier (six each at 480p / 720p /
// 1080p, in that order — src/runway.js keeps the same list). Atelier sends 720p, or 1080p for '16:9 · HD'.
export const SEEDANCE_SECONDS = Object.freeze([4, 6, 8, 10, 15, 20, 30]);
export const SEEDANCE_PROMPT_MAX = 15000;
export const SEEDANCE_RATIOS = Object.freeze({
  '480p': Object.freeze(['992:432', '854:480', '752:560', '640:640', '560:752', '480:854']),
  '720p': Object.freeze(['1470:630', '1280:720', '1112:834', '960:960', '834:1112', '720:1280']),
  '1080p': Object.freeze(['2206:946', '1920:1080', '1664:1248', '1440:1440', '1248:1664', '1080:1920']),
});

// credits: per second; min: per generation. i2v / t2v / v2v: image → video, text → video, video → video.
// seconds: the lengths the model takes (else RUNWAY_SECONDS); ratios: its own ratio list; hd: has a 1080p ratio.
// Veo 3.1 (with audio, Runway's default): 40 credits/s, Fast 15 (https://docs.dev.runwayml.com/guides/pricing/).
export const RUNWAY_MODELS = Object.freeze({
  'gen4.5': Object.freeze({ label: 'Runway Gen-4.5', credits: 12, min: 0, i2v: true, t2v: true, v2v: false }),
  gen4_turbo: Object.freeze({ label: 'Runway Gen-4 Turbo', credits: 5, min: 0, i2v: true, t2v: false, v2v: false }),
  aleph2: Object.freeze({ label: 'Runway Aleph', credits: 28, min: 56, i2v: false, t2v: false, v2v: true }),
  'veo3.1': Object.freeze({ label: 'Veo 3.1 (Runway)', credits: 40, min: 0, i2v: true, t2v: true, v2v: false, seconds: VEO_SECONDS, ratios: VEO_RATIOS, hd: true }),
  'veo3.1_fast': Object.freeze({ label: 'Veo 3.1 Fast (Runway)', credits: 15, min: 0, i2v: true, t2v: true, v2v: false, seconds: VEO_SECONDS, ratios: VEO_RATIOS, hd: true }),
  // Grok Imagine: credits per second by resolution (credits: 720p's), +1 credit for an image → video start frame.
  grok_imagine_1_5: Object.freeze({ label: 'Grok Imagine 1.5 (Runway)', credits: 16, rates: Object.freeze({ '480p': 10, '720p': 16, '1080p': 29 }), still: 1, min: 0, i2v: true, t2v: true, v2v: false, seconds: GROK_SECONDS, grok: true, hd: true }),
  grok_imagine_1_5_lite: Object.freeze({ label: 'Grok Imagine 1.5 Lite (Runway)', credits: 3, rates: Object.freeze({ '480p': 2, '720p': 3, '1080p': 14 }), still: 1, min: 0, i2v: true, t2v: true, v2v: false, seconds: GROK_SECONDS, grok: true, hd: true }),
  // Seedance 2.5: 20 / 30 / 68 credits a second at 480p / 720p / 1080p (credits: 720p's), sound included, at least 80
  // credits a generation. range: Runway takes any whole length in it (the menu offers `seconds`).
  seedance2_5: Object.freeze({ label: 'Seedance 2.5 (Runway)', credits: 30, rates: Object.freeze({ '480p': 20, '720p': 30, '1080p': 68 }), min: 80, i2v: true, t2v: true, v2v: false, seconds: SEEDANCE_SECONDS, range: Object.freeze([4, 30]), seedance: true, hd: true }),
});

// Entries for app.js VIDEO_MODELS (appended after the Veo entries). auto:false — Auto never spends Runway credits;
// only picking one in the menu does.
export const RUNWAY_VIDEO_MODELS = Object.freeze([
  Object.freeze({ id: 'runway:gen4.5', label: 'Runway Gen-4.5', runway: 'gen4.5', auto: false, note: 'Runway Gen-4.5 ≈ $0.12/sec · text or image → video' }),
  Object.freeze({ id: 'runway:gen4_turbo', label: 'Runway Gen-4 Turbo · animate a still', runway: 'gen4_turbo', needsImage: true, auto: false, note: 'Runway Gen-4 Turbo ≈ $0.05/sec · attach a still to animate' }),
  // Google's Veo 3.1 through Runway (owner only; it shuts down on the Gemini API on 2026-10-22).
  Object.freeze({ id: 'runway:veo3.1', label: 'Veo 3.1 · Runway', runway: 'veo3.1', auto: false, note: 'Veo 3.1 on Runway ≈ $0.40/sec with sound · text or image → video' }),
  Object.freeze({ id: 'runway:veo3.1_fast', label: 'Veo 3.1 Fast · Runway', runway: 'veo3.1_fast', auto: false, note: 'Veo 3.1 Fast on Runway ≈ $0.15/sec with sound · text or image → video' }),
  // xAI's Grok Imagine through Runway (owner only). Lite: Runway's 2026-10-01 addition.
  Object.freeze({ id: 'runway:grok_imagine_1_5_lite', label: 'Grok Imagine 1.5 Lite · Runway', runway: 'grok_imagine_1_5_lite', auto: false, note: 'Grok Imagine 1.5 Lite on Runway ≈ $0.03/sec at 720p · text or image → video' }),
  Object.freeze({ id: 'runway:grok_imagine_1_5', label: 'Grok Imagine 1.5 · Runway', runway: 'grok_imagine_1_5', auto: false, note: 'Grok Imagine 1.5 on Runway ≈ $0.16/sec at 720p with sound · text or image → video' }),
  // ByteDance's Seedance 2.5 through Runway (owner only; Runway 2026-08-07).
  Object.freeze({ id: 'runway:seedance2_5', label: 'Seedance 2.5 · Runway', runway: 'seedance2_5', auto: false, note: 'Seedance 2.5 on Runway ≈ $0.30/sec at 720p with sound · text or image → video' }),
]);
// Video → video edits (a clip attached in Video mode). Not in the menu until app.js routes clips there (phase 1b).
export const RUNWAY_EDIT_MODEL = Object.freeze({ id: 'runway:aleph2', label: 'Runway Aleph · edit a video', runway: 'aleph2', v2v: true, auto: false, note: 'Runway Aleph ≈ $0.28/sec · at least $0.56' });

// Waits (ms). Mutable so tests and odd networks can adjust them.
// poll: Runway updates a task at most every 5 s · jitter: added 0…jitter to every poll · backoffMax: cap for retries
// after 429/5xx/network drops · total: give up waiting (the task is kept for Try again) · request: one API call ·
// download: the MP4 download · failures: consecutive failed polls before giving up · accountTtl: account cache ·
// create / uplink / createMax: the paid create call gets create ms plus the body's upload time at `uplink` bytes a
// second (a slow phone), at most createMax — its inline still can be ~4 MB, and giving up early can orphan a task.
export const RUNWAY_TIMING = { poll: 5000, jitter: 2500, backoffMax: 60_000, total: 20 * 60_000, request: 30_000, download: 5 * 60_000, failures: 8, accountTtl: 600_000,
  create: 60_000, uplink: 32_000, createMax: 240_000 };
// How long the create call may take for a body of `bytes`.
export function createTimeout(bytes) {
  const T = RUNWAY_TIMING, n = Math.max(0, Number(bytes) || 0);
  return Math.min(T.createMax, T.create + Math.ceil(n / T.uplink) * 1000);
}

// ── pure helpers ──
export const isRunwayId = (id) => typeof id === 'string' && /^runway:/.test(id);
export const runwayModelOf = (id) => {
  const m = isRunwayId(id) ? id.slice(7) : '';
  return Object.hasOwn(RUNWAY_MODELS, m) ? m : null;
};
const credits$ = (c) => `$${(c * USD_PER_CREDIT).toFixed(2)}`;
const n$ = (n) => Number(n).toLocaleString('en-US');

// Credits and dollars for `seconds` of `model` → {credits, usd}, or null (unknown model / no length).
// opts (Grok Imagine): {resolution} its per-resolution rate (else 720p's), {still: true} the start frame's credit.
export function quote(model, seconds, { resolution, still = false } = {}) {
  const m = RUNWAY_MODELS[model];
  if (!Object.hasOwn(RUNWAY_MODELS, model) || !(Number(seconds) > 0)) return null;
  const rate = m.rates && Object.hasOwn(m.rates, resolution ?? '') ? m.rates[resolution] : m.credits;
  const credits = Math.max(m.min, Math.ceil(Number(seconds)) * rate + (still && m.still ? m.still : 0));
  return { credits, usd: Math.round(credits) / 100 };
}
// '≈ 48 credits ($0.48)'
export function quoteNote(model, seconds, opts) {
  const q = quote(model, seconds, opts);
  return q ? `≈ ${n$(q.credits)} credits (${credits$(q.credits)})` : '';
}
// The Video-mode options strip note for a Runway menu entry: 'Runway Gen-4.5 · 4 s ≈ 48 credits ($0.48)'. aspect: the
// Video-mode aspect ('16:9hd' prices Grok Imagine at 1080p).
export function optionNote(entry, secs, aspect) {
  const model = entry?.runway;
  if (!Object.hasOwn(RUNWAY_MODELS, model ?? '')) return '';
  const s = runwaySeconds(secs, model), tiered = Boolean(RUNWAY_MODELS[model].rates), resolution = tiered ? (aspect === '16:9hd' ? '1080p' : '720p') : undefined;
  return `${RUNWAY_MODELS[model].label} · ${s} s ${quoteNote(model, s, { resolution })}${tiered ? ` · ${resolution}` : ''}${entry.needsImage ? ' · attach a still' : ''}`;
}
// Over this many credits ($5) app.js asks before a new paid task (runwayVideo's approve): Seedance 2.5 at 30 s, 1080p is
// 2,040 credits ($20.40) for one send, and an Ask-mode message can start several videos on the saved Video options
// without the price note on screen. The Worker's RUNWAY_MAX_CREDITS, when set, is the hard cap behind it.
export const ASK_OVER_CREDITS = 500;
// The confirm() question for `seconds` of `model` (opts as quote's) when it costs over ASK_OVER_CREDITS, else ''.
export function spendQuestion(model, seconds, opts = {}) {
  const q = quote(model, seconds, opts);
  if (!q || q.credits <= ASK_OVER_CREDITS) return '';
  const res = RUNWAY_MODELS[model].rates && opts.resolution ? ` at ${opts.resolution}` : '';
  return `Make this ${Math.ceil(Number(seconds))} s ${RUNWAY_MODELS[model].label} video${res}? It costs about ${n$(q.credits)} credits (${credits$(q.credits)}) of your Runway balance.`;
}
// '48 credits ($0.48)' for a finished task's real cost; '' when unknown.
export const creditsNote = (c) => (Number.isFinite(c) && c >= 0 ? `${n$(c)} credit${c === 1 ? '' : 's'} (${credits$(c)})` : '');

// The allowed Runway ratio closest to w:h (by |ln aspect|). Unknown sizes → the list's first (16:9).
export function ratioFor(w, h, kind = 'image_to_video') {
  const list = kind === 'text_to_video' ? T2V_RATIOS : I2V_RATIOS;
  if (!(w > 0 && h > 0 && Number.isFinite(w / h))) return list[0];
  const want = Math.log(w / h);
  let best = list[0], gap = Infinity;
  for (const r of list) {
    const [a, b] = r.split(':').map(Number), d = Math.abs(Math.log(a / b) - want);
    if (d < gap - 1e-9) { best = r; gap = d; }
  }
  return best;
}
// Runway refuses a prompt image whose width ÷ height is outside these (docs: assets/inputs, "Input asset aspect ratio
// requirements") — it does NOT crop it first. Phone screenshots (≈ 0.45) and wide panoramas fall outside. Veo 3.1 has
// no such range listed (the still goes as is; its output ratio follows the still's orientation). Seedance 2.5: 0.4–4
// (a 4.4:1 panorama or a long scrolling screenshot is outside; cropStill cuts it in with rangeCrop).
export const INPUT_ASPECT = Object.freeze({ 'gen4.5': Object.freeze([0.5, 2]), gen4_turbo: Object.freeze([0.5, 2.358]), seedance2_5: Object.freeze([0.4, 4]) });
// A w×h still for `model` → {ratio, crop}: the output ratio (ratioFor), and the centre crop {x, y, w, h} that gives the
// image that shape — what Runway would cut anyway — kept 1% inside the model's input range so later rounding can't push
// it out (gen4.5's 1584:672 is wider than its 2:1 limit: the still is cut to ~2:1 and Runway trims the rest).
// crop is null when the still is already that shape (within 0.5%).
export function stillPlan(w, h, model = 'gen4.5') {
  const ratio = ratioFor(w, h, 'image_to_video');
  if (!(w > 0 && h > 0 && Number.isFinite(w / h))) return { ratio, crop: null };
  const [lo, hi] = INPUT_ASPECT[model] || INPUT_ASPECT['gen4.5'];
  const [a, b] = ratio.split(':').map(Number);
  const want = Math.min(hi / 1.01, Math.max(lo * 1.01, a / b)), have = w / h;
  if (Math.abs(Math.log(have / want)) < 0.005) return { ratio, crop: null };
  let cw = w, ch = h;
  if (have > want) cw = Math.min(w, Math.max(1, Math.round(h * want)));
  else ch = Math.min(h, Math.max(1, Math.round(w / want)));
  while (cw / ch > hi && cw > 1) cw--;
  while (cw / ch < lo && ch > 1) ch--;
  return { ratio, crop: { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch } };
}
// A w×h still for a model whose output ratio buildRequest picks (Seedance 2.5) → the centre crop {x, y, w, h} that
// brings it inside the model's INPUT_ASPECT range, kept 1% inside like stillPlan's; null when it is already ≥ 0.5%
// inside (it goes as is). 4000×900 (4.44:1) → 3564×900 (3.96:1); 1080×2800 (0.39) → 1080×2673 (0.404).
export function rangeCrop(w, h, model) {
  const lim = INPUT_ASPECT[model];
  if (!lim || !(w > 0 && h > 0 && Number.isFinite(w / h))) return null;
  const [lo, hi] = lim, have = w / h;
  if (have >= lo * 1.005 && have <= hi / 1.005) return null;
  let cw = w, ch = h;
  if (have > hi / 1.005) cw = Math.min(w, Math.max(1, Math.round((h * hi) / 1.01)));
  else ch = Math.min(h, Math.max(1, Math.round(w / (lo * 1.01))));
  while (cw / ch > hi && cw > 1) cw--;
  while (cw / ch < lo && ch > 1) ch--;
  return { x: Math.floor((w - cw) / 2), y: Math.floor((h - ch) / 2), w: cw, h: ch };
}
// Browser only (called at send time): a still data: URL → {src, ratio, w, h}, centre-cropped per stillPlan (Seedance:
// rangeCrop) as a JPEG of at most 2048 px a side; app.js's shrinkDataUrl sizes it for the request afterwards. Unchanged
// when no crop is needed. ratio null: buildRequest picks it (from the still's size and the Video-mode aspect).
export async function cropStill(src, model = 'gen4.5') {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(fail(400, 'Atelier couldn’t read that image for Runway — try another one.'));
    i.src = src;
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  // Veo 3.1: buildRequest picks the ratio from the still's orientation and the aspect ('16:9 · HD' → 1920:1080 / 1080:1920)
  if (RUNWAY_MODELS[model]?.ratios) return { src, ratio: null, w, h };
  if (RUNWAY_MODELS[model]?.grok) return { src, ratio: null, w, h }; // Grok Imagine: the output follows the still
  // Seedance: buildRequest picks the ratio (it knows HD); only a still outside Runway's 0.4–4 is cut, into that range
  const plan = RUNWAY_MODELS[model]?.seedance ? { ratio: null, crop: rangeCrop(w, h, model) } : stillPlan(w, h, model);
  if (!plan.crop) return { src, ratio: plan.ratio, w, h };
  const { x, y, w: cw, h: ch } = plan.crop, k = Math.min(1, 2048 / Math.max(cw, ch));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(cw * k)); c.height = Math.max(1, Math.round(ch * k));
  c.getContext('2d').drawImage(img, x, y, cw, ch, 0, 0, c.width, c.height);
  return { src: c.toDataURL('image/jpeg', 0.92), ratio: plan.ratio, w: c.width, h: c.height };
}
// '832:1104' → [832, 1104] (for the 'developing' placeholder's aspect-ratio); null when malformed.
export function ratioBox(ratio) {
  const m = /^(\d{2,5}):(\d{2,5})$/.exec(String(ratio || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
// Video-mode aspect ('16:9' | '9:16' | '16:9hd') → text → video ratio.
export const t2vRatio = (aspect) => (aspect === '9:16' ? '720:1280' : '1280:720');
// A length Runway takes: whole seconds 2–10 (default 5); for a model with its own lengths (Veo 3.1: 4/6/8) the nearest
// one of those at or below (else its shortest).
export function runwaySeconds(secs, model) {
  const s = Math.round(Number(secs)), list = RUNWAY_MODELS[model]?.seconds, range = RUNWAY_MODELS[model]?.range;
  if (range && Number.isFinite(s) && s >= range[0] && s <= range[1]) return s; // Seedance: any whole length in range
  if (list) return list.includes(s) ? s : [...list].reverse().find((x) => x <= s) ?? (Number.isFinite(s) && s > 0 ? list[0] : 6);
  // (Grok Imagine's list is GROK_SECONDS: Runway takes any whole 1–15 s, the menu offers those)
  return Number.isFinite(s) && s >= 2 && s <= 10 ? s : 5;
}
/** The Video-mode length menu for a Runway model. */
export const runwaySecondsFor = (model) => RUNWAY_MODELS[model]?.seconds || RUNWAY_SECONDS;
// After a model switch (app.js): `secs` snapped to the model's menu — kept if the menu has it, else its longest length
// at or below it, else its shortest — so the select, the note and the request agree (20 s from Seedance → 10 s on
// Gen-4.5, where runwaySeconds' 5 s isn't in the menu and the select would show '2 s').
export function runwayMenuSeconds(secs, model) {
  const menu = runwaySecondsFor(model), s = Math.round(Number(secs));
  return menu.includes(s) ? s : [...menu].reverse().find((x) => x <= s) ?? menu[0];
}
// Veo 3.1 on Runway: the ratio for the Video-mode aspect ('16:9hd' is 1920:1080), or for a still's orientation.
export function veoRatio({ w, h, aspect } = {}) {
  if (w > 0 && h > 0) return h > w ? (aspect === '16:9hd' ? '1080:1920' : '720:1280') : aspect === '16:9hd' ? '1920:1080' : '1280:720';
  return aspect === '9:16' ? '720:1280' : aspect === '16:9hd' ? '1920:1080' : '1280:720';
}
// Grok Imagine on Runway → {ratio, resolution} for the Video-mode aspect. 1.5: 16:9 / 9:16 plus a resolution field (no
// ratio from a still); Lite: the size ratio (text) or auto_<res> (still). '16:9hd' is 1080p (Lite: 720p upscaled).
export function grokShape(model, { aspect, still = false, wantRatio } = {}) {
  const hd = aspect === '16:9hd', portrait = aspect === '9:16', resolution = hd ? '1080p' : '720p';
  if (model === 'grok_imagine_1_5') return { ratio: still ? null : portrait ? '9:16' : '16:9', resolution };
  if (still) return { ratio: hd ? 'auto_1080p' : 'auto_720p', resolution };
  if (/^(720:1280|1280:720|1904:1072|1072:1904)$/.test(wantRatio || '')) return { ratio: wantRatio, resolution: /1904|1072/.test(wantRatio) ? '1080p' : '720p' };
  return { ratio: hd ? '1904:1072' : portrait ? '720:1280' : '1280:720', resolution };
}
// Seedance 2.5 on Runway → {ratio, resolution}: a ratio the caller already chose (Remix's 1280:720 frame), else 720p
// ('16:9 · HD': 1080p) in the shape closest to the still (16:9, 4:3, 1:1, 3:4, 9:16 or 21:9), else the aspect's 16:9 / 9:16.
export function seedanceShape({ aspect, w, h, wantRatio } = {}) {
  for (const [res, list] of Object.entries(SEEDANCE_RATIOS)) if (list.includes(wantRatio)) return { ratio: wantRatio, resolution: res };
  const resolution = aspect === '16:9hd' ? '1080p' : '720p', list = SEEDANCE_RATIOS[resolution];
  if (!(w > 0 && h > 0 && Number.isFinite(w / h))) return { ratio: aspect === '9:16' ? list[5] : list[1], resolution };
  const want = Math.log(w / h);
  let best = list[1], gap = Infinity;
  for (const r of list) {
    const [a, b] = r.split(':').map(Number), d = Math.abs(Math.log(a / b) - want);
    if (d < gap - 1e-9) { best = r; gap = d; }
  }
  return { ratio: best, resolution };
}
// After switching from Runway back to Omni / Cosmos: a length of 4/6/8 s.
export const veoSeconds = (secs) => (VEO_SECONDS.includes(+secs) ? +secs : +secs > 8 ? 8 : 4);

// Why a clip can't go to Aleph → 'too-short' | 'too-long' | 'too-large' | 'type' | null. v: {duration, size, type}.
export function alephProblem(v = {}) {
  const type = String(v.type || v.mime || '').split(';')[0].trim().toLowerCase();
  if (type && !UPLOAD_TYPES.includes(type)) return 'type';
  if (!type) return 'type';
  if (Number(v.size) > UPLOAD_MAX) return 'too-large';
  if (Number(v.duration) > 0 && v.duration < ALEPH_MIN_S) return 'too-short';
  if (Number(v.duration) > ALEPH_MAX_S) return 'too-long';
  return null;
}
export const ALEPH_PROBLEM_TEXT = Object.freeze({
  'too-short': 'Runway Aleph needs at least 2 s — use a longer clip',
  'too-long': 'Runway Aleph takes 2–30 s — trim the clip first',
  'too-large': 'Over 95 MB — export it at 1080p, 30 fps for Runway',
  type: 'Runway takes MP4, MOV, WebM or MKV clips',
});

// Prompt → at most PROMPT_MAX UTF-16 units, cut at a word boundary when it has to be cut.
export function clampPrompt(text) {
  const s = String(text ?? '').trim();
  if (s.length <= PROMPT_MAX) return s;
  const cut = s.slice(0, PROMPT_MAX), sp = cut.lastIndexOf(' ');
  return (sp > PROMPT_MAX * 0.8 ? cut.slice(0, sp) : cut).replace(/[\ud800-\udbff]$/, '').trim();
}

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// One Video-mode request → {kind, body, ratio, seconds, note} for POST /api/runway/generate/<kind>.
// still: a data:image URL (JPEG/PNG/WebP ≤ 5 MB) and stillSize {w, h}; ratio: the output ratio cropStill chose (else
// it is picked from stillSize); aspect/secs: the Video-mode options; videoUri: a runway:// upload (Aleph); framing:
// 'keep' or a TARGET_ASPECTS value (Aleph outpaint).
export function buildRequest({ model, prompt, still, stillSize, ratio: wantRatio, aspect, secs, videoUri, framing, seed, seconds } = {}) {
  const spec = RUNWAY_MODELS[model];
  if (!Object.hasOwn(RUNWAY_MODELS, model)) throw fail(400, 'That Runway model isn’t available in Atelier.');
  const promptText = clampPrompt(prompt);
  const extra = Number.isInteger(seed) && seed >= 0 && seed <= 4294967295 ? { seed } : {};
  if (spec.v2v) {
    if (typeof videoUri !== 'string' || !videoUri.startsWith('runway://')) throw fail(400, 'Attach a clip for Runway Aleph to edit.');
    if (!promptText) throw fail(400, 'Describe the edit you want Runway to make.');
    const body = { model, promptText, videoUri, ...extra, ...(TARGET_ASPECTS.includes(framing) ? { targetAspectRatio: framing } : {}) };
    if (Number(seconds) > 0) body.seconds = Number(seconds); // the Worker echoes a quote from it; never sent to Runway
    return { kind: 'video_to_video', body, ratio: null, seconds: Number(seconds) > 0 ? Number(seconds) : null, note: 'video edit' };
  }
  const duration = runwaySeconds(secs, model);
  if (spec.grok) { // Grok Imagine: the still as is; a prompt is optional with a still, needed without one
    const text = String(prompt ?? '').trim().slice(0, GROK_PROMPT_MAX).trim();
    const { ratio, resolution } = grokShape(model, { aspect, still: Boolean(still), wantRatio });
    const res = model === 'grok_imagine_1_5' ? { resolution } : {};
    const r = ratio ? { ratio } : {};
    if (still) {
      if (typeof still !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(still)) throw fail(400, 'Runway takes JPEG, PNG or WebP images.');
      if (still.length > DATA_URI_MAX) throw fail(413, 'That image is too large for Runway (5 MB) — try a smaller one.');
      return { kind: 'image_to_video', body: { model, ...(text ? { promptText: text } : {}), promptImage: still, ...r, ...res, duration }, ratio, resolution, seconds: duration, note: 'image → video' };
    }
    if (!text) throw fail(400, 'Describe the video you want Grok Imagine to make.');
    return { kind: 'text_to_video', body: { model, promptText: text, ...r, ...res, duration }, ratio, resolution, seconds: duration, note: 'text → video' };
  }
  if (spec.seedance) { // Seedance 2.5: the still as is; a prompt is optional with a still, needed without one
    const text = String(prompt ?? '').trim().slice(0, SEEDANCE_PROMPT_MAX).trim();
    const { ratio, resolution } = seedanceShape({ aspect, w: stillSize?.w, h: stillSize?.h, wantRatio });
    if (still) {
      if (typeof still !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(still)) throw fail(400, 'Runway takes JPEG, PNG or WebP images.');
      if (still.length > DATA_URI_MAX) throw fail(413, 'That image is too large for Runway (5 MB) — try a smaller one.');
      return { kind: 'image_to_video', body: { model, ...(text ? { promptText: text } : {}), promptImage: still, ratio, duration, ...extra }, ratio, resolution, seconds: duration, note: 'image → video' };
    }
    if (!text) throw fail(400, 'Describe the video you want Seedance to make.');
    return { kind: 'text_to_video', body: { model, promptText: text, ratio, duration, ...extra }, ratio, resolution, seconds: duration, note: 'text → video' };
  }
  if (spec.ratios) { // Veo 3.1: its own ratios, 4/6/8 s; the still goes as is
    if (!promptText) throw fail(400, 'Describe the video you want Veo to make.');
    const ratio = spec.ratios.includes(wantRatio) ? wantRatio : veoRatio({ w: stillSize?.w, h: stillSize?.h, aspect });
    if (still) {
      if (typeof still !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(still)) throw fail(400, 'Runway takes JPEG, PNG or WebP images.');
      if (still.length > DATA_URI_MAX) throw fail(413, 'That image is too large for Runway (5 MB) — try a smaller one.');
      return { kind: 'image_to_video', body: { model, promptText, promptImage: still, ratio, duration, ...extra }, ratio, seconds: duration, note: 'image → video' };
    }
    return { kind: 'text_to_video', body: { model, promptText, ratio, duration, ...extra }, ratio, seconds: duration, note: 'text → video' };
  }
  if (still) {
    if (typeof still !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(still)) throw fail(400, 'Runway takes JPEG, PNG or WebP images.');
    if (still.length > DATA_URI_MAX) throw fail(413, 'That image is too large for Runway (5 MB) — try a smaller one.');
    const ratio = I2V_RATIOS.includes(wantRatio) ? wantRatio : ratioFor(stillSize?.w, stillSize?.h, 'image_to_video');
    if (model === 'gen4.5' && !promptText) throw fail(400, 'Describe the video you want Runway to make.'); // Turbo may go without
    return { kind: 'image_to_video', body: { model, ...(promptText ? { promptText } : {}), promptImage: still, ratio, duration, ...extra }, ratio, seconds: duration, note: 'image → video' };
  }
  if (!spec.t2v) throw fail(400, `${spec.label} animates a still image — attach one, or pick Runway Gen-4.5 for text → video.`);
  if (!promptText) throw fail(400, 'Describe the video you want Runway to make.');
  const ratio = t2vRatio(aspect);
  return { kind: 'text_to_video', body: { model, promptText, ratio, duration, ...extra }, ratio, seconds: duration, note: 'text → video' };
}

// How long to wait before the next poll (ms). failures: consecutive failed polls (429/5xx/network);
// retryAfter: the server's retry-after in seconds; hintMs: the task's pollAfterMs. Never under RUNWAY_TIMING.poll.
export function pollDelay({ failures = 0, retryAfter, hintMs, random = Math.random } = {}) {
  const T = RUNWAY_TIMING, r = Math.min(1, Math.max(0, Number(random()) || 0));
  if (failures > 0) {
    const base = Math.min(T.backoffMax, T.poll * 2 ** failures), ra = Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0;
    const wait = Math.min(T.backoffMax, Math.max(base, ra));
    return Math.round(wait * (1 + 0.5 * r)); // up to 50% jitter, as Runway asks
  }
  return Math.round(Math.max(T.poll, Number(hintMs) || 0) + r * T.jitter);
}

// The pending card's line for a task status.
export function statusText(task) {
  const s = task?.status;
  if (s === 'PENDING') return 'Queued at Runway';
  if (s === 'THROTTLED') return 'Queued at Runway · waiting for a free slot';
  if (s === 'RUNNING') {
    const p = Number(task.progress);
    return p > 0 && p <= 1 ? `Filming with Runway · ${Math.round(p * 100)}%` : 'Filming with Runway';
  }
  if (s === 'SUCCEEDED') return 'Downloading from Runway';
  if (s === 'FAILED' || s === 'CANCELLED') return '';
  return 'Working at Runway';
}

// A FAILED task → an Error {status, code, message} worded for people (Runway says to treat the codes as diagnostics).
// status follows app.js errorKind: 400 + "safety/rephrasing" → 'filtered', 503 → 'busy'. The charge note names dollars
// only: errorKind reads "credit", "billing" or "quota" in a message as a key/account problem, which would hide the
// "Try rephrasing" card (the credits stay on the error as `credits`).
export function failureOf(task) {
  const code = typeof task?.failureCode === 'string' ? task.failureCode : '';
  const spent = Number(task?.cost?.credits);
  const charged = spent > 0 ? ` Runway still charged ${credits$(spent)} for this attempt.` : '';
  let status, message;
  if (/^SAFETY\./i.test(code) || /^INPUT_PREPROCESSING\.SAFETY/i.test(code)) {
    status = 400; message = 'Runway’s safety filter blocked this — try rephrasing.';
  } else if (/^ASSET\.INVALID/i.test(code)) {
    status = 400; message = 'Runway couldn’t use that input — clips must be 2–30 s at 30 fps or less; images JPEG, PNG or WebP, between 1:2 and 2:1.';
  } else if (/^INTERNAL\.BAD_OUTPUT/i.test(code)) {
    status = 400; message = 'Runway couldn’t make a clean video from that — try again without logos or text in the image, and describe the scene rather than asking for a prompt.';
  } else {
    status = 503; message = 'Runway had a hiccup making this video — try again in a moment.';
  }
  return fail(status, message + charged, { code: 'runway_failed', failureCode: code || null, credits: spent > 0 ? spent : 0 });
}

// ── "Use Runway Gen-4.5?" ──
// Mentioning Runway never switches models by itself (that would spend credits on a guess); it only offers the switch.
// Brand mentions vs. the fashion/airport runway: a strong signal (RunwayML, "runway gen-4.5", "runway api"…, a model
// name), or a verb right before it ("test runway", "use runway"), or "Runway" capitalised mid-sentence.
const STRONG = /\brunway\s*ml\b|\brunway(?:'s|’s)?\s+(?:gen[-\s_]?4(?:\.5)?|aleph|api|turbo|video\s+models?|capabilit\w*|credits?|key)\b|\bgen[-_\s]?4\.5\b|\bgen[-_]?4[-_\s]turbo\b|\baleph\s?2\b/i;
const NOT_BRAND = /\b(?:fashion|catwalk|models?\s+(?:walk|strut)\w*|airports?|air\s?planes?|aircraft|jets?|planes?|takeoff|take\s+off|taxi(?:ing|s)?)\b/i;
const VERB = /\b(?:test(?:ing)?|try(?:ing)?|use|using|with|via|through|by|ask)\s+runway\b(?!\s*(?:show|walk|look|season|collection|strip|lights?|models?|\d))/i;
function properNoun(s) {
  for (const m of s.matchAll(/\bRunway\b/g)) {
    const before = s.slice(0, m.index);
    if (!before.trim() || /[.!?:]\s*$/.test(before)) continue; // sentence start: ambiguous
    if (/\b(?:the|a|an|this|that|on|down|off|of)\s*$/i.test(before)) continue;
    return true;
  }
  return false;
}
export function mentionsRunway(text) {
  const s = String(text ?? '').slice(0, 4000);
  if (!/runway|gen[-_\s]?4|aleph/i.test(s)) return false;
  if (STRONG.test(s)) return true;
  if (NOT_BRAND.test(s)) return false;
  return VERB.test(s) || properNoun(s);
}
// → {id, model, label} for the hint chip, or null. current: the Video model now in use (id); ready: Runway usable;
// hasImage: a still is attached (Gen-4 Turbo can take it); edit: Aleph is routable (a clip is attached, phase 1b).
export function runwayHint(prompt, { current = '', ready = false, hasImage = false, edit = false } = {}) {
  if (!ready || isRunwayId(current) || !mentionsRunway(prompt)) return null;
  const s = String(prompt);
  const model = edit && /aleph/i.test(s) ? 'aleph2' : hasImage && /\bturbo\b/i.test(s) ? 'gen4_turbo' : 'gen4.5';
  const label = { 'gen4.5': 'Runway Gen-4.5', gen4_turbo: 'Runway Gen-4 Turbo', aleph2: 'Runway Aleph' }[model];
  return { id: `runway:${model}`, model, label: `Use ${label}?` };
}

// Settings → Connections row → {on, state, detail} (plain text: escape it). account: runwayAccount()'s answer.
export function connectionRow({ configured = false, passcode = false, account = null } = {}) {
  if (!configured) return { on: false, state: 'Not set up', detail: passcode ? 'set RUNWAYML_API_SECRET' : 'needs the server passcode' };
  if (!passcode) return { on: false, state: 'Needs passcode', detail: 'enter the server passcode to use Runway' };
  if (account?.ok === false) {
    if (account.code === 'runway_key') return { on: false, state: 'Key rejected', detail: 'check RUNWAYML_API_SECRET at dev.runway.com' };
    return { on: true, state: 'Connected', detail: 'couldn’t read the credit balance just now' };
  }
  if (!account?.ok) return { on: true, state: 'Connected', detail: 'Gen-4.5 · Gen-4 Turbo · Veo 3.1 · Grok Imagine video' };
  const parts = [];
  if (Number.isFinite(account.creditBalance)) parts.push(`${n$(account.creditBalance)} credits (${credits$(account.creditBalance)})`);
  const lim = account.models?.['gen4.5']?.maxConcurrentGenerations;
  if (Number.isInteger(lim) && lim > 0) parts.push(`${lim} video${lim === 1 ? '' : 's'} at a time`);
  return { on: true, state: 'Connected', detail: parts.join(' · ') || 'Gen-4.5 · Gen-4 Turbo · Veo 3.1 · Grok Imagine video' };
}

// ── browser: talking to /api/runway/* ──
const abortError = () => new DOMException('Aborted', 'AbortError');
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(abortError());
  const ab = () => { clearTimeout(t); rej(abortError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', ab); res(); }, ms);
  signal?.addEventListener('abort', ab, { once: true });
});
// apiHeaders: app.js's apiHeaders function (called with no arguments) or a plain headers object.
const headersFor = (apiHeaders, extra = {}) => {
  const h = new Headers(typeof apiHeaders === 'function' ? apiHeaders() : apiHeaders || {});
  for (const [k, v] of Object.entries(extra)) { if (v == null) h.delete(k); else h.set(k, v); }
  return h;
};
// A signal that fires on the caller's abort or after `ms` (then late() is true); done() drops the timer and listener.
function timed(signal, ms) {
  const ctrl = new AbortController(), ab = () => ctrl.abort();
  let late = false;
  const timer = setTimeout(() => { late = true; ctrl.abort(); }, ms);
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', ab, { once: true });
  return { signal: ctrl.signal, late: () => late, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', ab); } };
}
const readJson = async (r) => { try { const j = await r.json(); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } };
// A Worker refusal → Error {status, code, retryAfter, task} carrying the Worker's own wording (already written for
// people). task: a Runway task id the refusal names (runway_cap_running: made but over the cap, cancel still pending).
function errorFrom(r, j, fallback) {
  const ra = Number(r.headers?.get?.('retry-after'));
  return fail(r.status, typeof j.error === 'string' && j.error ? j.error.slice(0, 400) : fallback,
    { ...(typeof j.code === 'string' ? { code: j.code } : {}), ...(ra > 0 ? { retryAfter: ra } : {}), ...(typeof j.id === 'string' && /^[0-9a-f-]{36}$/i.test(j.id) ? { task: j.id } : {}) });
}
// One JSON call to the Worker (capped at `timeout`, RUNWAY_TIMING.request by default). body: an object, or JSON text.
// Network trouble → Error {status: 0, resumable, timedOut}.
async function call(method, path, { apiHeaders, body, signal, timeout = RUNWAY_TIMING.request } = {}) {
  const t = timed(signal, timeout);
  try {
    let r;
    try {
      r = await fetch(path, { method, signal: t.signal, headers: headersFor(apiHeaders, body === undefined ? { 'content-type': null } : { 'content-type': 'application/json' }), body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    } catch {
      if (signal?.aborted) throw abortError();
      throw fail(0, t.late() ? 'Atelier took too long to answer — check your connection.' : 'Couldn’t reach Atelier — the connection dropped.', { resumable: true, timedOut: t.late() });
    }
    const j = await readJson(r);
    if (signal?.aborted) throw abortError();
    if (!r.ok) throw errorFrom(r, j, `The Runway request failed (${r.status}).`);
    return j;
  } finally { t.done(); }
}
const transient = (s) => s === 0 || s === 408 || s === 429 || s >= 500;

// POST /api/runway/generate/<kind> → {id, estimatedCost, quote}. The one call that costs money, and Runway takes no
// idempotency key: it gets its own timeout (createTimeout, sized to the body), and when no answer comes back it says
// a video may have started anyway — never `resumable`, since there is no task id to resume or cancel.
export async function createTask(kind, body, { apiHeaders, signal } = {}) {
  const text = JSON.stringify(body);
  try { return await call('POST', `/api/runway/generate/${kind}`, { apiHeaders, signal, body: text, timeout: createTimeout(text.length) }); }
  catch (err) {
    if (err?.status !== 0) throw err;
    throw fail(0, `${err.timedOut ? 'Runway didn’t confirm the new video in time' : 'The connection dropped before Runway confirmed the new video'} — it may have started anyway. Check your Runway usage at dev.runway.com before trying again.`, { code: 'runway_unconfirmed' });
  }
}
export const getTask = (id, opts = {}) => call('GET', `/api/runway/task/${encodeURIComponent(id)}`, opts);
// Fire-and-forget cancel (Stop): resolves true/false, never rejects. keepalive lets it finish while the page closes.
export function cancelTask(id, { apiHeaders } = {}) {
  if (typeof id !== 'string' || !id) return Promise.resolve(false);
  const t = timed(null, RUNWAY_TIMING.request);
  return fetch(`/api/runway/task/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true, signal: t.signal, headers: headersFor(apiHeaders, { 'content-type': null }) })
    .then((r) => r.ok, () => false).finally(t.done);
}
// GET /api/runway/output/<id>?i=0 → a video/mp4 Blob.
export async function downloadOutput(id, { apiHeaders, signal, index = 0 } = {}) {
  const t = timed(signal, RUNWAY_TIMING.download);
  try {
    let r;
    try { r = await fetch(`/api/runway/output/${encodeURIComponent(id)}?i=${index}`, { signal: t.signal, headers: headersFor(apiHeaders, { 'content-type': null }) }); }
    catch {
      if (signal?.aborted) throw abortError();
      throw fail(0, 'The Runway video download dropped — tap Try again (it won’t make a new video).', { resumable: true });
    }
    if (!r.ok) throw errorFrom(r, await readJson(r), `Downloading the Runway video failed (${r.status}).`);
    let blob;
    try { blob = await r.blob(); } catch {
      if (signal?.aborted) throw abortError();
      throw fail(0, 'The Runway video download dropped — tap Try again (it won’t make a new video).', { resumable: true });
    }
    if (!blob.size) throw fail(502, 'Runway sent back an empty video — try again.', { resumable: true });
    // Always video/mp4 (or webm): backups only restore those data: types (data-safety.js safeMediaUrl).
    return /^video\/(mp4|webm)$/.test(blob.type) ? blob : new Blob([blob], { type: 'video/mp4' });
  } finally { t.done(); }
}

// Polls a task until it finishes → the SUCCEEDED task. Every wait comes from pollDelay (≥ 5 s, jittered, backing off
// on 429/5xx/drops). FAILED → failureOf(task); CANCELLED → 409; gone → 404 {code:'runway_gone'}; over
// RUNWAY_TIMING.total → 504 {code:'runway_slow', resumable}. immediate: poll once before the first wait (resuming).
export async function waitForTask(id, { apiHeaders, signal, onStatus, immediate = false, sleep: wait = sleep, random = Math.random, now = Date.now } = {}) {
  const T = RUNWAY_TIMING, end = now() + T.total;
  let failures = 0, retryAfter = 0, hint = T.poll, first = immediate;
  for (;;) {
    if (!first) {
      const ms = pollDelay({ failures, retryAfter, hintMs: hint, random });
      if (now() + ms > end) throw fail(504, 'Runway is still working on this after 20 minutes — tap Try again to keep waiting (it won’t start a new video).', { code: 'runway_slow', resumable: true });
      await wait(ms, signal);
    }
    first = false;
    let task;
    try { task = await getTask(id, { apiHeaders, signal }); }
    catch (err) {
      if (err?.name === 'AbortError') throw err;
      if (!transient(err.status)) throw err;
      if (++failures > T.failures) throw Object.assign(err, { resumable: true });
      retryAfter = err.retryAfter || 0;
      continue;
    }
    failures = 0; retryAfter = 0;
    hint = Number(task.pollAfterMs) || T.poll;
    try { onStatus?.(statusText(task), task); } catch (err) { console.error(err); }
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED') throw failureOf(task);
    if (task.status === 'CANCELLED') throw fail(409, 'The Runway video was cancelled.', { code: 'runway_cancelled' });
  }
}

// ── one Runway job at a time (Tier 1 runs one video at once; more would only sit THROTTLED at Runway) ──
const slots = { busy: 0, waiting: [] };
export async function takeSlot(limit = 1, signal, onWait) {
  const max = Math.max(1, Math.floor(Number(limit)) || 1);
  let told = false;
  while (slots.busy >= max) {
    if (!told) { told = true; try { onWait?.(); } catch {} }
    await new Promise((res, rej) => {
      if (signal?.aborted) return rej(abortError());
      const w = { res: () => { signal?.removeEventListener('abort', ab); res(); } };
      const ab = () => { const i = slots.waiting.indexOf(w); if (i >= 0) slots.waiting.splice(i, 1); rej(abortError()); };
      slots.waiting.push(w);
      signal?.addEventListener('abort', ab, { once: true });
    });
  }
  slots.busy++;
  let released = false;
  return () => { if (released) return; released = true; slots.busy--; slots.waiting.shift()?.res(); };
}
export const slotState = () => ({ busy: slots.busy, waiting: slots.waiting.length });

// Stop while the create call is in flight: reject at once, but let the request finish — Runway may already have
// started (and will bill) the task, and only its answer carries the id to cancel. orphan(made) gets that answer.
function untilStopped(p, signal, orphan) {
  if (!signal) return p;
  return new Promise((res, rej) => {
    const ab = () => { p.then(orphan, (err) => orphan(err?.task ? { id: err.task } : null)); rej(abortError()); };
    if (signal.aborted) return ab();
    signal.addEventListener('abort', ab, { once: true });
    p.then((v) => { signal.removeEventListener('abort', ab); res(v); }, (err) => { signal.removeEventListener('abort', ab); rej(err); });
  });
}
// Download refusals that mean the video can't be fetched again, however often Try again is tapped.
const FOR_GOOD = new Set(['runway_gone', 'runway_no_output', 'runway_too_large']);
const AGAIN_FREE = ' Tap Try again to download it again — it won’t make (or charge for) a new video.';

// The whole job: [wait for a slot →] create (or resume) → poll → download → {id, blob, credits, estimate}.
// onTask(id): the task now exists (app.js keeps it on the entry so Try again resumes instead of paying twice);
// onStatus(text, task): pending-card text. resume: a task id from an earlier, unfinished attempt.
// Errors carry task (the id) and resumable: true while Try again should check on that task rather than pay for a new
// one: a timeout or drop while it ran, any download failure once it SUCCEEDED (it is paid for; Runway hands out fresh
// links), and Stop. Stop cancels a task that is still queued or running (the Worker leaves a finished one alone) and
// never touches one that already SUCCEEDED; resuming a task that turns out cancelled or gone starts a new one.
// approve(): asked (and awaited) just before a new paid task is created — never for a resumed one; false stops there
// with an AbortError and nothing sent (app.js: confirm(spendQuestion(…)) for a big spend).
export async function runwayVideo(req, { apiHeaders, signal, onStatus, onTask, resume = null, approve = null, limit, sleep: wait, random, now } = {}) {
  if (signal?.aborted) throw abortError();
  const say = (text, task) => { if (text) try { onStatus?.(text, task); } catch (err) { console.error(err); } };
  const release = await takeSlot(limit ?? accountLimit(req?.body?.model), signal, () => say('Waiting for your other Runway video'));
  let id = null, last = null; // the task, and the last status seen for it
  const seen = (text, task) => { if (typeof task?.status === 'string') last = task.status; say(text, task); };
  const poll = (immediate) => waitForTask(id, { apiHeaders, signal, onStatus: seen, immediate, sleep: wait, random, now });
  try {
    let task = null, estimate = null;
    if (typeof resume === 'string' && resume) {
      id = resume; // a Stop while checking on it reaches it too
      say('Checking on the earlier Runway video');
      try { task = await poll(true); }
      catch (err) {
        if (err?.code !== 'runway_gone' && err?.code !== 'runway_cancelled' && err?.status !== 404) throw err;
        id = null; last = null; // gone (expired, deleted) or cancelled by an earlier Stop: make a new one
      }
    }
    if (!task) {
      if (signal?.aborted) throw abortError();
      if (approve && !(await approve())) throw abortError(); // the owner said no to the price: nothing was sent
      if (signal?.aborted) throw abortError();
      say('Sending to Runway');
      let made;
      try { made = await untilStopped(createTask(req.kind, req.body, { apiHeaders }), signal, (late) => { if (late?.id) cancelTask(late.id, { apiHeaders }); }); }
      catch (err) { if (err?.task) cancelTask(err.task, { apiHeaders }); throw err; } // runway_cap_running: retry the Worker's cancel
      if (typeof made.id !== 'string' || !made.id) throw fail(502, 'Runway didn’t return a task id.');
      id = made.id; last = 'PENDING';
      estimate = Number(made.estimatedCost?.credits);
      try { onTask?.(id, made); } catch (err) { console.error(err); }
      say('Queued at Runway');
      task = await poll(false);
    }
    last = 'SUCCEEDED';
    say('Downloading from Runway', task);
    let blob;
    try { blob = await downloadOutput(id, { apiHeaders, signal }); }
    catch (err) {
      if (err?.name !== 'AbortError' && !FOR_GOOD.has(err?.code) && err?.status !== 404) {
        err.resumable = true; // made and paid for: Try again only downloads it
        if (!/won’t make a new video|won’t make \(or charge for\)/.test(err.message)) err.message = `${err.message.replace(/\s*—\s*try again\.?$/i, '.')}${AGAIN_FREE}`;
      }
      throw err;
    }
    const credits = Number(task.cost?.credits);
    return { id, blob, credits: Number.isFinite(credits) ? credits : null, estimate: Number.isFinite(estimate) ? estimate : null };
  } catch (err) {
    if (err?.name === 'AbortError' && id) {
      if (last !== 'SUCCEEDED') cancelTask(id, { apiHeaders }); // Stop: don't let it run (and bill) on
      err.resumable = true; // Try again checks on it: a finished video downloads free, a cancelled one starts afresh
    }
    if (id && err && typeof err === 'object' && !err.task) err.task = id;
    throw err;
  } finally { release(); }
}

// POST /api/runway/upload: a clip (or image) → {runwayUri, expiresAt}. XHR in browsers for upload progress.
export function uploadToRunway(file, { apiHeaders, signal, onProgress } = {}) {
  const type = String(file?.type || '').split(';')[0].toLowerCase();
  if (!UPLOAD_TYPES.includes(type)) return Promise.reject(fail(415, ALEPH_PROBLEM_TEXT.type));
  if (!(file.size >= UPLOAD_MIN)) return Promise.reject(fail(400, 'That file is too small for Runway.'));
  if (file.size > UPLOAD_MAX) return Promise.reject(fail(413, ALEPH_PROBLEM_TEXT['too-large']));
  const headers = headersFor(apiHeaders, { 'content-type': type });
  const ok = (j) => {
    if (typeof j.runwayUri !== 'string' || !j.runwayUri.startsWith('runway://')) throw fail(502, 'Runway didn’t confirm the upload — attach the file again.');
    return { runwayUri: j.runwayUri, expiresAt: Number(j.expiresAt) || Date.now() + 23 * 3600e3 };
  };
  if (typeof XMLHttpRequest !== 'function') {
    return fetch('/api/runway/upload', { method: 'POST', headers, body: file, signal })
      .catch((err) => { if (signal?.aborted) throw abortError(); throw fail(0, 'The upload to Runway dropped — attach the file again.', { cause: err }); })
      .then(async (r) => { const j = await readJson(r); if (!r.ok) throw errorFrom(r, j, `The upload to Runway failed (${r.status}).`); return ok(j); });
  }
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(abortError());
    const x = new XMLHttpRequest(), ab = () => x.abort();
    x.open('POST', '/api/runway/upload');
    headers.forEach((v, k) => x.setRequestHeader(k, v));
    x.upload.onprogress = (e) => { if (e.lengthComputable) try { onProgress?.(e.loaded / e.total); } catch {} };
    x.onload = () => {
      signal?.removeEventListener('abort', ab);
      let j = {};
      try { j = JSON.parse(x.responseText); } catch {}
      const r = { status: x.status, headers: { get: (h) => x.getResponseHeader(h) } };
      try { if (x.status < 200 || x.status >= 300) throw errorFrom(r, j && typeof j === 'object' ? j : {}, `The upload to Runway failed (${x.status}).`); res(ok(j)); } catch (err) { rej(err); }
    };
    x.onerror = () => { signal?.removeEventListener('abort', ab); rej(fail(0, 'The upload to Runway dropped — attach the file again.')); };
    x.onabort = () => { signal?.removeEventListener('abort', ab); rej(abortError()); };
    signal?.addEventListener('abort', ab, { once: true });
    x.send(file);
  });
}

// GET /api/runway/account, cached for RUNWAY_TIMING.accountTtl → {ok:true, creditBalance, usd, maxMonthlyCreditSpend,
// models} or {ok:false, status, code, error}. Never rejects (except on abort).
let accountCache = null; // {at, value}
export async function runwayAccount({ apiHeaders, signal, force = false } = {}) {
  if (!force && accountCache && Date.now() - accountCache.at < RUNWAY_TIMING.accountTtl) return accountCache.value;
  try {
    const j = await call('GET', '/api/runway/account', { apiHeaders, signal });
    const value = { ok: true, creditBalance: Number.isFinite(j.creditBalance) ? j.creditBalance : null, usd: Number.isFinite(j.usd) ? j.usd : null,
      maxMonthlyCreditSpend: Number.isFinite(j.maxMonthlyCreditSpend) ? j.maxMonthlyCreditSpend : null, models: j.models && typeof j.models === 'object' ? j.models : {} };
    accountCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { ok: false, status: err?.status ?? 0, code: err?.code || null, error: err?.message || 'Couldn’t read the Runway account.' };
  }
}
export const forgetAccount = () => { accountCache = null; };
// The account's concurrent-video limit for a model (cached account only; 1 when unknown; null = no limit → 4).
export function accountLimit(model) {
  const lim = accountCache?.value?.models?.[model]?.maxConcurrentGenerations;
  return lim === null ? 4 : Number.isInteger(lim) && lim > 0 ? lim : 1;
}
