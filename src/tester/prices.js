// Atelier tester metering: the conservative price table and cost functions.
// Spec: docs/superpowers/specs/2026-09-30-atelier-tester-access-design.md §6-§7, plus the addendum (A2 video, A3 web search).
//
// UNITS
//   Token prices are USD per 1M tokens. That number is also micro-dollars (µ$) per token: $4/MTok = 4 µ$/token.
//   Per-image, per-second and per-search prices are plain USD.
//   Every exported cost function returns an INTEGER number of micro-dollars, rounded UP.
//   The arithmetic is exact (BigInt pico-dollars, 1 µ$ = 1e6 p$), so floating point never drifts.
//
// MARGIN
//   Reserve functions (chatWorstCase, imageCost, veoCost) multiply by MARGIN by default.
//   Settle functions (chatActual, imageActual, omniActual) return the exact cost by default. Pass `margin: true|false` to override.
//
// CONSERVATIVE RULES
//   - Long-context tiers: the top-level rates in each entry are the HIGHER tier, and the worst case always uses them.
//     chatActual uses the tier the reported prompt actually fell in (`base` holds the lower tier and its threshold).
//     Claude Haiku 5.5 is the one Anthropic model with a tier: $0.10/$0.50 up to 100K prompt tokens (input + cache
//     reads + cache writes), $0.50/$2.50 above.
//   - Fresh input is reserved at max(input, cacheWrite). src/anthropic.js marks a tester's request with 5-minute
//     breakpoints only (system, last history message, the turn, and automatic caching on tool rounds: 1.25x input), and
//     OpenAI GPT-6 Chat Completions write the cache by default (1.25x input). cacheWrite here is Anthropic's 5-MINUTE
//     rate: the owner's requests use the 1-hour cache, a tester's never do. If a tester's ever did, the worst case must
//     switch to cacheWrite1h. Settling reads the 5-minute / 1-hour split from usage.cache_creation either way.
//   - Gemini 3.8 Flash: the published 2027-01-01 price (2x the current promo) is the standing price.
//     chatActual uses the promo price for requests dated through 2026-12-31 (UTC).
//   - DeepSeek: peak-hour prices always (off-peak is half).
//   - Anthropic fallbacks:'default' bills the declined attempt AND the fallback attempt (refusals-and-fallback,
//     "Billing and rate limits"). The worst case is the primary attempt plus the most expensive fallback target,
//     each with full input and max_tokens of output. Default routing makes one hop to one recommended model.
//   - A model without a verified, published price is not in this table, so testers cannot use it.
//   - Image inputs on a model that publishes no per-image token rule cannot be priced. chatWorstCase refuses them
//     (PriceError 'unpriced_images'). Text-only models refuse images with 'no_vision'.
//
// ASSUMPTIONS (estimates, not published numbers; each one is a named export so it can be tuned)
//   WEB_SEARCH_RESULT_TOKENS, GEMINI_VIDEO_TOKENS_PER_SECOND, OPENAI_EDIT_IMAGE_TOKENS,
//   GEMINI_PRO_IMAGE_THINKING_TOKENS, GEMINI_FLASH_IMAGE_THINKING_TOKENS, DEFAULT_IMAGE_PROMPT_TOKENS,
//   TTS_MIN_CHARS_PER_SECOND, TTS_INSTRUCTION_TOKENS (read aloud, src/tts.js), OMNI_TOKENS_PER_SECOND (by resolution: only 720p is published), STT_MIN_BYTES_PER_SECOND (dictation).
//   The provider floors in MIN_OUTPUT mirror the max_tokens clamps in src/anthropic.js and src/gemini.js (2026-09-30).
//
// SOURCES (read 2026-09-30; Anthropic, Google and OpenAI re-read 2026-10-07 for the v80 model update)
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//              (and the claude-api skill reference: models table cached 2026-09-25, shared/model-migration.md)
//              https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback   fallback billing, usage.iterations
//              https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool  $10 per 1,000 searches
//              https://platform.claude.com/docs/en/build-with-claude/vision                  at most 4,784 tokens per image
//   OpenAI     https://developers.openai.com/api/docs/pricing   (platform.openai.com/docs/pricing redirects here)
//              https://developers.openai.com/api/docs/guides/images-vision      patch sizing; gpt-6-astra multiplier 1.2
//              https://developers.openai.com/api/docs/guides/image-generation   GPT Image 2.5 output-token calculator
//   Google     https://ai.google.dev/gemini-api/docs/pricing   (page last updated 2026-10-01 UTC)
//              https://ai.google.dev/gemini-api/docs/media-resolution   https://ai.google.dev/gemini-api/docs/video-understanding
//              https://ai.google.dev/gemini-api/docs/tokens             https://ai.google.dev/gemini-api/docs/image-generation
//              https://ai.google.dev/gemini-api/docs/omni   https://ai.google.dev/gemini-api/docs/deprecations
//   OpenAI     https://developers.openai.com/api/docs/models/gpt-transcribe   ($0.0045 per minute of audio)
//   Z.ai       https://docs.z.ai/guides/overview/pricing
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing
//   Meta       https://dev.meta.ai/docs/pricing-rate-limits
//   NVIDIA     https://developer.nvidia.com/nim   ("free access to NIM API endpoints for unlimited prototyping",
//              for development and testing). There is no per-token price page; meter at $0 and count requests.

export const PRICES_CHECKED = '2026-10-07';
export const MARGIN = 1.25;

/** Spec §6: one call never reserves more than $0.25. Default budget for maxTokensWithin. */
export const PER_CALL_RESERVE_CAP = 250_000;
/** Addendum A7b: a chat call with Claude web search may reserve up to $0.50 (fallbacks off, max_uses 3, 2 or 1). */
export const WEB_CALL_RESERVE_CAP = 500_000;
/** Addendum A7b: one generated video (Gemini Omni) never reserves more than $1.00 (and must fit the day, month and pool). */
export const VEO_CALL_RESERVE_CAP = 1_000_000;

/** Anthropic web search fee: $10 per 1,000 searches (failed searches are not billed). */
export const WEB_SEARCH_USD = 0.01;
/**
 * ASSUMPTION. Search-result tokens that one search adds to the context. The size is not published. The docs' own
 * examples show about 6-7K for a basic search, and dynamic filtering (web_search_20260209) trims it further.
 * 25K is the higher of the two research estimates (10-25K). Settle reads the exact counts from usage.
 */
export const WEB_SEARCH_RESULT_TOKENS = 25_000;
/**
 * ASSUMPTION (the docs disagree). Video: 70/frame by default and 280/frame at high on Gemini 3 (media-resolution);
 * 258/frame (video-understanding); 263/s (tokens). Audio: 25/s (media-resolution) or 32/s (tokens). Default 1 FPS.
 * Ceiling used: 300 video + 32 audio = 332 tokens per second, as in addendum A2.
 */
export const GEMINI_VIDEO_TOKENS_PER_SECOND = 332;
/**
 * ASSUMPTION. Input tokens for one reference image on a GPT Image 2.5 edit. OpenAI publishes no rule for 2.5
 * (it says inputs are always processed at high fidelity). This bounds both published vision rules: 30,000 patches
 * (the API's rejection limit) x 1.62 (the largest published multiplier) = 48,600, which also covers the tile rule
 * (gpt-4o-mini maximum ≈ 48,169).
 */
export const OPENAI_EDIT_IMAGE_TOKENS = 48_600;
/**
 * ASSUMPTION. Thinking/text output allowance per Gemini image request. Thinking is on and cannot be disabled.
 * Interim "thought images" are not charged, but thinking text bills at the text-output rate and its size is not
 * published. The router should set generationConfig.maxOutputTokens to (image tokens + this) so the provider enforces it.
 */
export const GEMINI_PRO_IMAGE_THINKING_TOKENS = 8_192;
export const GEMINI_FLASH_IMAGE_THINKING_TOKENS = 8_192; // Nano Banana 2.1 thinks at "medium" by default (3.1 Flash Image: "minimal")
/** ASSUMPTION. Prompt-token allowance when imageCost is called without `promptTokens`. Pass ceil(promptBytes / 3). */
export const DEFAULT_IMAGE_PROMPT_TOKENS = 4_096;
/** Output floors the server code applies: anthropic.js clamps max_tokens to >= 1024; gemini.js native video chat to >= 256. */
export const MIN_OUTPUT = Object.freeze({ anthropic: 1024, geminiNative: 256 });
/*
 * Read aloud is Gemini speech only (gemini-3.8-flash-tts for the Atelier voice, gemini-3.8-flash-lite-tts for Sulafat).
 * Gemini TTS publishes 25 audio tokens per second, but the reported count runs above it: a live Sulafat read on
 * 2026-10-01 reported 388 audio tokens for 12.2 s (≈ 31.8/s). So Gemini settles at max(the reported count, seconds x 25):
 * seconds x 25 is only a floor for an answer that reports less. The reservation stays a true ceiling because a tester's
 * maxOutputTokens is the reserved audio tokens (the reported count can't pass it) and ttsActual's maxAudioTokens holds
 * the seconds floor to the same bound. Both models are reserved at their reserveTokensPerSecond (32) and settled so.
 */
/**
 * ASSUMPTION. The slowest read-aloud delivery, in spoken units per second: the brief's slow, pause-rich pace runs ~11-13
 * characters of prose a second. A tester's reservation counts the units of src/tts.js ttsCeilingUnits, a ceiling on the
 * reading time: digits (4 units) and CJK characters (3) as in spokenUnits, a symbol said as a word ($ % & @ # + = * / \
 * and the like) 10, any other symbol, fraction or Roman numeral (≤ → ≈ < > | ~ ^ ½) 21 and an emoji cluster (™ and ©
 * included) 37 or more, so number-, symbol- or emoji-heavy and Chinese/Japanese/Korean text is reserved for its longer
 * reading time. At 10 characters a second those weights cover names of about 12, 26 and 46 characters. A text read
 * slower still is held to its reservation at the source: a tester's maxOutputTokens is the reserved audio tokens.
 */
export const TTS_MIN_CHARS_PER_SECOND = 8;
/** ASSUMPTION. Input tokens the Gemini voice style (src/tts.js GEMINI_STYLE, well under 100 tokens) adds. */
export const TTS_INSTRUCTION_TOKENS = 200;
/**
 * Gemini Omni Flash video output tokens per second, by resolution. Published: "5,792 tokens per second of 720p video"
 * (pricing page, 2026-10-07) at $17.50 per 1M video output tokens = $0.10136 a second. ASSUMPTION for the others, which
 * the page doesn't price: 360p at the 720p rate (never less), 1080p twice it and 4K four times (both are upscaled).
 * Reservations use these; a finished video settles from the interaction's reported usage (omniActual).
 */
export const OMNI_TOKENS_PER_SECOND = Object.freeze({ '360p': 5_792, '720p': 5_792, '1080p': 11_584, '4k': 23_168 });
/**
 * ASSUMPTION. The lowest bit rate a dictation recording is reserved at when its length can't be read from its header
 * (only WAV says how long it is): 1,000 bytes a second (8 kbit/s). The app records AAC/Opus at 64 kbit/s (8,000 B/s),
 * and speech codecs don't go below ~6 kbit/s. gpt-transcribe bills per second of audio, so such a recording is reserved
 * as its byte length at this rate (120 s at 64 kbit/s: 983 s, $0.074 x 1.25); settle reads the billed seconds.
 */
export const STT_MIN_BYTES_PER_SECOND = 1_000;

export class PriceError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PriceError';
    this.code = code;
  }
}

const SRC = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  openaiImages: 'https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/guides/image-generation',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
  zai: 'https://docs.z.ai/guides/overview/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  meta: 'https://dev.meta.ai/docs/pricing-rate-limits',
  nvidia: 'https://developer.nvidia.com/nim',
};

// ───────────────────────────── table ─────────────────────────────
// Chat fields (USD per 1M tokens): input, output, cacheWrite, cacheRead [, cacheWrite1h].
// imageTokens: worst-case input tokens per attached image; 0 = text-only model; null = no published rule.
const anthropic = (input, output, cacheWrite, cacheWrite1h, cacheRead, extra = {}) => ({
  kind: 'chat', provider: 'anthropic', input, output, cacheWrite, cacheWrite1h, cacheRead,
  imageTokens: 4784, webSearchUsd: WEB_SEARCH_USD, minOutput: MIN_OUTPUT.anthropic, source: SRC.anthropic, ...extra,
});
const OPENAI_LONG = 272_000; // "Short context: ≤272K input tokens. Long context: >272K" (whole request repriced)
const GEMINI_PRO_LONG = 200_000; // "prompts <= 200k tokens"
const nvidiaChat = (note) => ({ kind: 'chat', provider: 'nvidia', free: true, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, imageTokens: 0, source: SRC.nvidia, note });

const TABLE = {
  // ── Anthropic (claude-api skill + platform.claude.com pricing page). No long-context premium except Haiku 5.5's tier.
  'anthropic:claude-opus-5-5': anthropic(4, 20, 5, 8, 0.2, {
    fallbacks: ['anthropic:claude-opus-5', 'anthropic:claude-opus-4-8'],
    note: 'Cache reads 0.05x. Thinking is always on and bills as output inside max_tokens.',
  }),
  // Cache hits $0.10 (0.05x input, pricing page footnote 2, read 2026-10-08; was $0.20 here, which over-settled reads).
  'anthropic:claude-sonnet-5-5': anthropic(2, 10, 2.5, 4, 0.1, {
    fallbacks: ['anthropic:claude-sonnet-5'],
    note: 'Cache reads 0.05x. Default fallback retries cyber and frontier_llm declines on Claude Sonnet 5.',
  }),
  // Haiku 5.5: two rate cards by prompt length (claude-api skill, models.md / model-migration.md cached 2026-10-06):
  // $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above; cache reads 0.1x input, 5-minute writes 1.25x, 1-hour
  // writes 2x. No server-side refusal fallback for this model.
  'anthropic:claude-haiku-5-5': anthropic(0.5, 2.5, 0.625, 1, 0.05, {
    base: { upTo: 100_000, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
    note: 'The fast role (titles, routing, helpers). Adaptive thinking bills as output inside max_tokens. Worst case at the >100K rates.',
  }),
  'anthropic:claude-fable-5-1': anthropic(10, 50, 12.5, 20, 0.25, {
    fallbacks: ['anthropic:claude-opus-5', 'anthropic:claude-opus-4-8'],
    note: 'Most expensive chat model. Cache reads 0.025x. Needs 30-day retention (ZDR orgs get a 400).',
  }),
  // Fallback targets: priced so settle can cost usage.iterations entries. Testers cannot request them directly.
  'anthropic:claude-opus-5': anthropic(5, 25, 6.25, 10, 0.5, {
    fallbacks: ['anthropic:claude-opus-4-8'], tester: false, why: 'server-side fallback target only (not in app.js roles)',
  }),
  'anthropic:claude-opus-4-8': anthropic(5, 25, 6.25, 10, 0.5, { tester: false, why: 'server-side fallback target only' }),
  'anthropic:claude-sonnet-5': anthropic(2, 10, 2.5, 4, 0.2, {
    tester: false, why: 'server-side fallback target only', note: 'The cancelled 2026-09-01 increase means $2/$10 is now standard.',
  }),

  // ── OpenAI (Standard tier; regional/data-residency endpoints +10% are not used by the worker).
  'openai:gpt-6-luna': {
    kind: 'chat', provider: 'openai', input: 0.2, output: 0.75, cacheWrite: 0.25, cacheRead: 0.02,
    base: { upTo: OPENAI_LONG, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    imageTokens: null, source: SRC.openai,
    note: 'Not in the vision sizing/multiplier table, so per-image tokens are unpublished. Reasoning bills as output inside max_completion_tokens.',
  },
  'openai:gpt-6-astra': {
    kind: 'chat', provider: 'openai', input: 20, output: 75, cacheWrite: 25, cacheRead: 2,
    base: { upTo: OPENAI_LONG, input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
    imageTokens: 36_000, imageTokensDetailHigh: 3_000, source: `${SRC.openai} ; https://developers.openai.com/api/docs/guides/images-vision`,
    note: 'Image detail defaults to auto (= original): up to 30,000 patches x 1.2 = 36,000 tokens. detail:"high" caps at 2,500 x 1.2 = 3,000.',
  },
  'openai:gpt-6.1-sol': {
    kind: 'chat', provider: 'openai', input: 4, output: 15, cacheWrite: 5, cacheRead: 0.2,
    base: { upTo: OPENAI_LONG, input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    imageTokens: null, source: SRC.openai,
    note: 'Not in the vision sizing/multiplier table, so per-image tokens are unpublished.',
  },

  // ── Google Gemini (Paid tier, Standard). Implicit caching has no write fee (cacheWrite = input).
  'gemini:gemini-3.8-flash': {
    kind: 'chat', provider: 'gemini', input: 1.5, output: 7.5, cacheWrite: 1.5, cacheRead: 0.15,
    promo: { until: '2026-12-31', input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.075 },
    imageTokens: 2_240, videoTokensPerSecond: GEMINI_VIDEO_TOKENS_PER_SECOND, source: SRC.gemini,
    note: '$0.75/$3.75 through 2026-12-31, then $1.50/$7.50. One input rate for text/image/video/audio. Image 1,120 by default, 2,240 at ultra_high.',
  },
  'gemini:gemini-3.1-pro-preview': {
    kind: 'chat', provider: 'gemini', input: 4, output: 18, cacheWrite: 4, cacheRead: 0.4,
    base: { upTo: GEMINI_PRO_LONG, input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 },
    imageTokens: 2_240, videoTokensPerSecond: GEMINI_VIDEO_TOKENS_PER_SECOND, source: SRC.gemini,
  },
  'gemini:gemini-3.5-flash-lite': {
    kind: 'chat', provider: 'gemini', input: 0.3, output: 2.5, cacheWrite: 0.3, cacheRead: 0.03,
    imageTokens: 2_240, videoTokensPerSecond: GEMINI_VIDEO_TOKENS_PER_SECOND, source: SRC.gemini,
  },

  // ── Z.ai. No cache-write charge; cached-input storage "limited-time free". GLM-5.x always thinks (billed as output).
  'zai:glm-5.3': { kind: 'chat', provider: 'zai', input: 1.4, output: 4.4, cacheWrite: 1.4, cacheRead: 0.26, imageTokens: 0, source: SRC.zai, note: 'Text-only.' },
  'zai:glm-5.3-flash': { kind: 'chat', provider: 'zai', input: 0.15, output: 0.5, cacheWrite: 0.15, cacheRead: 0.03, imageTokens: null, source: SRC.zai, note: 'Multimodal, but per-image tokens are unpublished.' },
  'zai:glm-4.7-flash': { kind: 'chat', provider: 'zai', free: true, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, imageTokens: 0, source: SRC.zai, note: 'Listed as Free (rate-limited).' },

  // ── DeepSeek (PEAK prices: 01:00-04:00 and 06:00-10:00 UTC Mon-Fri; off-peak is half). No cache-write charge.
  'deepseek:deepseek-flash': { kind: 'chat', provider: 'deepseek', input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006, imageTokens: null, source: SRC.deepseek, note: 'DeepSeek-V4.1-Flash. Vision supported, but per-image tokens are unpublished.' },
  'deepseek:deepseek-v4-pro': { kind: 'chat', provider: 'deepseek', input: 1.32, output: 3.96, cacheWrite: 1.32, cacheRead: 0.044, imageTokens: 0, source: SRC.deepseek, note: 'DeepSeek-V4-Pro-0813. No vision.' },

  // ── Meta (Standard tier; never the -contributor ids, which train on prompts).
  'meta:muse-spark-1.3': { kind: 'chat', provider: 'meta', input: 1.25, output: 4.25, cacheWrite: 1.25, cacheRead: 0.15, imageTokens: null, source: SRC.meta, note: 'Image tokens scale with resolution and have no published cap.' },

  // ── NVIDIA build (bare ids; free on the owner's key, rate- and quota-limited: count requests).
  'deepseek-ai/deepseek-v4.1-flash': nvidiaChat(),
  'moonshotai/kimi-k3': nvidiaChat(),
  'z-ai/glm-5.3': nvidiaChat(),
  'nvidia/nemotron-3-super-120b-a12b': nvidiaChat(),
  'google/gemma-4-31b-it': nvidiaChat(),
  'nvidia/nemotron-3-ultra-550b-a55b': nvidiaChat(),
  'poolside/laguna-xs-2.1': nvidiaChat(),
  'meta/llama-3.2-90b-vision-instruct': nvidiaChat(),
  'nvidia/nemotron-3.5-lightning-30b-a3b': nvidiaChat(),
  'z-ai/glm-5.3-flash': nvidiaChat(),
  'openai/gpt-oss-20b': nvidiaChat(),
  'nvidia/nemotron-nano-3-30b-a3b': nvidiaChat(),

  // ── Images
  // GPT Image 2.5: token-priced. Output tokens per image come from OpenAI's published calculator (gptImageOutputTokens).
  // Cached-input pricing does not apply to the direct Images API. Each streamed partial image adds 100 output tokens.
  'openai:gpt-image-2.5-flare': {
    kind: 'image', provider: 'openai', textInput: 5, imageInput: 8, imageOutput: 30,
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'],
    sizes: ['1024x1024', '1024x1280', '1536x1024', '1024x1536', '1792x1008', '1008x1792'],
    source: SRC.openaiImages, note: 'quality/size "auto" cannot be priced and is refused.',
  },
  'openai:gpt-image-2.5-sunburst': {
    kind: 'image', provider: 'openai', textInput: 5, imageInput: 8, imageOutput: 30,
    qualities: ['low', 'medium', 'high', 'xhigh', 'max'],
    sizes: ['1024x1024', '1024x1280', '1536x1024', '1024x1536', '1792x1008', '1008x1792'],
    source: SRC.openaiImages, note: 'Used by app.js for /images/edits. The app sends no size (= auto, up to 8.29 MP): the router must force one.',
  },
  // Gemini image models: one image per request (candidateCount 1), so n means n requests.
  'gemini:gemini-3-pro-image': {
    kind: 'image', provider: 'gemini', textInput: 2, imageInput: 2, textOutput: 12, imageOutput: 120,
    imageTokens: { '1K': 1_120, '2K': 1_120, '4K': 2_000 }, inputImageTokens: 560,
    thinkingTokens: GEMINI_PRO_IMAGE_THINKING_TOKENS, source: SRC.gemini,
    note: '$0.134 per 1K/2K image, $0.24 per 4K. Input image 560 tokens. Thinking/text output $12/MTok on top.',
  },
  // Nano Banana 2.1 replaces the deprecated gemini-3.1-flash-image (Gemini API changelog, 2026-10-07).
  'gemini:gemini-nano-banana-2.1': {
    kind: 'image', provider: 'gemini', textInput: 1.5, imageInput: 1.5, textOutput: 7.5, imageOutput: 30,
    imageTokens: { '1K': 1_120, '2K': 1_680, '4K': 3_780 }, inputImageTokens: 2_240,
    thinkingTokens: GEMINI_FLASH_IMAGE_THINKING_TOKENS, source: SRC.gemini,
    note: '$0.0336 per 1K, $0.0504 per 2K, $0.113 per 4K. Input-image tokens unpublished: 2,240 (Gemini 3 ultra_high) assumed.',
  },
  'meta:muse-image-1.0': {
    kind: 'image', provider: 'meta', perImageUsd: 0.01,
    sizes: ['1024x1024', '1024x1280', '1536x1024', '1536x864', '864x1536'],
    source: SRC.meta, note: 'Flat $0.01 per generated image, any size; n images bill n. Failed/filtered images are not billed.',
  },
  'black-forest-labs/flux.1-dev': { kind: 'image', provider: 'nvidia', free: true, source: SRC.nvidia },
  'black-forest-labs/flux.2-klein-4b': { kind: 'image', provider: 'nvidia', free: true, source: SRC.nvidia, note: 'Also the EDIT_MODEL.' },
  'black-forest-labs/flux.1-schnell': { kind: 'image', provider: 'nvidia', free: true, source: SRC.nvidia },

  // ── Video. Gemini Omni Flash (Interactions API) bills output tokens: $17.50 per 1M video tokens, 5,792 a second at
  // 720p ($0.10136/s); input $1.50 and text/thinking output $9.00 per 1M. Only a produced video is billed. perSecond is
  // the reserve rate (OMNI_TOKENS_PER_SECOND x $17.50/MTok); a finished video settles from its usage (omniActual).
  // Veo 3.1 on the Gemini API shuts down 2026-10-22 (deprecations page); the owner keeps Veo 3.1 through Runway.
  'gemini:gemini-omni-1.1-flash': {
    kind: 'video', provider: 'gemini', omni: true, input: 1.5, videoOutput: 17.5, textOutput: 9,
    perSecond: { '360p': 0.10136, '720p': 0.10136, '1080p': 0.20272, '4k': 0.40544 }, durations: [4, 6, 8], source: SRC.gemini,
    note: '720p is published ($0.10136/s); 360p/1080p/4K reserve at the OMNI_TOKENS_PER_SECOND assumption. 8 s at 720p reserves $1.0136, over the $1.00 tester call cap, so testers get 4 s and 6 s.',
  },
  'nvidia/cosmos3-nano': { kind: 'video', provider: 'nvidia', free: true, source: `${SRC.nvidia} ; src/worker.js FUNCTIONS`, note: 'NVCF function; counted per request.' },
  'atelier/motion-still': { kind: 'video', provider: 'local', free: true, source: 'public/app.js VIDEO_MODELS (a free FLUX keyframe plus an in-browser camera move)' },

  // ── Speech (read aloud, src/tts.js). USD per 1M tokens: textInput (the text plus the voice brief), audioOutput.
  // (OpenAI gpt-4o-mini-tts retires 2027-01-06 with no /v1/audio/speech successor: read aloud is Gemini-only from v80.)
  'gemini:gemini-3.8-flash-tts': {
    kind: 'tts', provider: 'gemini', textInput: 1, audioOutput: 18, audioTokensPerSecond: 25, reserveTokensPerSecond: 32,
    promo: { until: '2026-12-31', textInput: 0.5, audioOutput: 9 }, source: SRC.gemini,
    note: 'The Atelier voice. $0.50 / $9.00 through 2026-12-31, then $1.00 / $18.00 (the standing price, used for the worst case). 25 audio tokens per second published, a floor; reserved at 32/s as for Sulafat.',
  },
  'gemini:gemini-3.8-flash-lite-tts': {
    kind: 'tts', provider: 'gemini', textInput: 1, audioOutput: 12, audioTokensPerSecond: 25, reserveTokensPerSecond: 32,
    promo: { until: '2026-12-31', textInput: 0.5, audioOutput: 6 }, source: SRC.gemini,
    note: '$0.50 / $6.00 through 2026-12-31, then $1.00 / $12.00 (the standing price, used for the worst case). 25 audio tokens per second published, a floor: a live read reported ≈ 31.8/s, and settle bills the reported count when higher.',
  },

  // ── Dictation (speech to text, src/transcribe.js). USD per 1M tokens; one input rate for audio and text.
  'openai:gpt-transcribe': {
    kind: 'stt', provider: 'openai', perMinute: 0.0045,
    source: `${SRC.openai} ; https://developers.openai.com/api/docs/models/gpt-transcribe`,
    note: 'Billed by audio duration ($0.0045 a minute; usage {type: "duration", seconds}). Reserved on the WAV length, else on the bytes at STT_MIN_BYTES_PER_SECOND.',
  },
  'gemini:gemini-3.5-flash-lite#stt': {
    kind: 'stt', provider: 'gemini', input: 0.3, output: 2.5, audioTokensPerSecond: 32,
    source: `${SRC.gemini} ; https://ai.google.dev/gemini-api/docs/audio`,
    note: 'The dictation fallback (gemini-3.5-flash-lite; its own id because the chat row has the bare one). 32 tokens per second of audio; output includes thinking.',
  },
};

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

/** The price table (USD), keyed by the exact ids Atelier uses (provider prefix as in app.js; bare ids are NVIDIA). */
export const PRICES = deepFreeze(TABLE);

// Addendum A7b: testers get metered models only. Free entries (the owner's NVIDIA quota, Z.ai's free tier, the FLUX
// motion still) cost $0, so the Ledger could not bound them.
const FREE_WHY = 'free ($0) model: testers use metered models only (addendum A7b)';
const testerOk = (e) => e.tester !== false && !e.free;
const keysOf = (kind) => Object.freeze(Object.keys(PRICES).filter((k) => PRICES[k].kind === kind && testerOk(PRICES[k])));
/** Chat models a tester may request (paid and priced; never a free model). */
export const TESTER_MODELS = keysOf('chat');
/** Image models a tester may use. */
export const TESTER_IMAGE_MODELS = keysOf('image');
/** Video models a tester may use. */
export const TESTER_VIDEO_MODELS = keysOf('video');
/** Speech (read aloud) models a tester may use. */
export const TESTER_TTS_MODELS = keysOf('tts');
/** Dictation (speech to text) models a tester may use. */
export const TESTER_STT_MODELS = keysOf('stt');
/** Priced models that testers still cannot use, with the reason. */
export const TESTER_EXCLUDED = deepFreeze(Object.fromEntries(Object.entries(PRICES).filter(([, e]) => !testerOk(e)).map(([k, e]) => [k, e.why || FREE_WHY])));

/** The table entry for a model id, or null. */
export const priceOf = (model) => (typeof model === 'string' && Object.hasOwn(PRICES, model) ? PRICES[model] : null);
/** True for $0 models (count requests instead of money). */
export const isFree = (model) => Boolean(priceOf(model)?.free);

// ───────────────────────────── exact arithmetic ─────────────────────────────
const PICO_PER_MICRO = 1_000_000n;
const MARGIN_PCT = BigInt(Math.round(MARGIN * 100));

// USD per 1M tokens → pico-dollars per token (exact for prices with up to 6 decimals).
function perToken(usdPerMTok) {
  const x = usdPerMTok * 1e6, r = Math.round(x);
  if (!Number.isFinite(x) || x < 0 || Math.abs(x - r) > 1e-6) throw new Error(`prices.js: unrepresentable price ${usdPerMTok}`);
  return BigInt(r);
}
// USD → pico-dollars.
const usdPico = (usd) => perToken(usd) * PICO_PER_MICRO;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const toMicros = (pico, margin) => Number(margin ? ceilDiv(pico * MARGIN_PCT, 100n * PICO_PER_MICRO) : ceilDiv(pico, PICO_PER_MICRO));
const big = (n) => BigInt(n);
const maxBig = (...xs) => xs.reduce((a, b) => (b > a ? b : a));

const rateSet = (r) => ({ input: perToken(r.input), output: perToken(r.output), cacheWrite: perToken(r.cacheWrite), cacheRead: perToken(r.cacheRead) });
// Pre-converted chat rates: top (higher tier / standing), base (lower tier), promo; plus Anthropic's 1h write.
const RATES = Object.fromEntries(Object.entries(PRICES).filter(([, e]) => e.kind === 'chat').map(([k, e]) => [k, {
  top: rateSet(e),
  base: e.base ? { ...rateSet(e.base), upTo: e.base.upTo, cacheWrite1h: perToken(e.base.cacheWrite1h ?? e.base.cacheWrite) } : null,
  promo: e.promo ? { ...rateSet(e.promo), until: e.promo.until } : null,
  cacheWrite1h: perToken(e.cacheWrite1h ?? e.cacheWrite),
  webSearch: e.webSearchUsd ? usdPico(e.webSearchUsd) : 0n,
}]));
// Speech rates: top (standing) and promo.
const TTS_RATES = Object.fromEntries(Object.entries(PRICES).filter(([, e]) => e.kind === 'tts').map(([k, e]) => [k, {
  top: { input: perToken(e.textInput), audio: perToken(e.audioOutput) },
  promo: e.promo ? { input: perToken(e.promo.textInput), audio: perToken(e.promo.audioOutput), until: e.promo.until } : null,
}]));
// Dictation rates: one input rate (audio and text) and the output rate; a duration-billed model (perMinute) has a
// per-second rate instead (exact: $0.0045 a minute is $0.000075 a second).
const STT_RATES = Object.fromEntries(Object.entries(PRICES).filter(([, e]) => e.kind === 'stt').map(([k, e]) => [k,
  e.perMinute ? { perSecond: usdPico(e.perMinute / 60) } : { input: perToken(e.input), output: perToken(e.output) }]));

// A count argument: a finite number >= 0, rounded up to an integer token/second/image count.
function count(v, name, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new PriceError('bad_input', `${name} is required`);
    return 0;
  }
  const n = Number(v);
  if (typeof v === 'boolean' || !Number.isFinite(n) || n < 0) throw new PriceError('bad_input', `${name} must be a number >= 0`);
  return Math.ceil(n);
}
// A usage field from a provider response: anything that isn't a positive number counts as 0.
const field = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0; };

function entryOf(model, kind) {
  const e = priceOf(model);
  if (!e) throw new PriceError('unknown_model', `No verified price for model "${model}"`);
  if (e.kind !== kind) throw new PriceError('wrong_kind', `"${model}" is a ${e.kind} model, not ${kind}`);
  return e;
}

// ───────────────────────────── chat ─────────────────────────────
// One attempt's worst case in pico-dollars: all input at max(input, cacheWrite), max_tokens of output, web searches.
function attemptWorst(model, a) {
  const e = PRICES[model], r = RATES[model].top;
  const inRate = maxBig(r.input, r.cacheWrite);
  let prompt = a.inputTokens;
  if (a.images > 0) {
    if (e.imageTokens === 0) throw new PriceError('no_vision', `${model} does not accept images`);
    if (e.imageTokens == null) throw new PriceError('unpriced_images', `${model} publishes no per-image token count`);
    prompt += a.images * (a.imageDetail === 'high' && e.imageTokensDetailHigh ? e.imageTokensDetailHigh : e.imageTokens);
  }
  if (a.videoSeconds > 0) {
    if (!e.videoTokensPerSecond) throw new PriceError('no_video', `${model} cannot watch video files`);
    prompt += a.videoSeconds * e.videoTokensPerSecond;
  }
  let input = big(prompt), fee = 0n;
  const S = e.webSearchUsd ? a.webSearches : 0; // other providers never run Claude's web search (the worker strips it)
  if (S > 0) {
    // Each search adds a sampling iteration that re-reads the context, and every result stays in the context for the
    // rest of the turn ("counted as input tokens, in search iterations executed during a single turn"):
    // total input = (S + 1) x prompt + R x S(S+1)/2, all at the full input rate (no cache-read discount assumed).
    input += big(S) * big(prompt) + big(WEB_SEARCH_RESULT_TOKENS) * big((S * (S + 1)) / 2);
    fee = big(S) * RATES[model].webSearch;
  }
  let out = a.maxTokens;
  if (e.minOutput) out = Math.max(out, e.minOutput);
  if (a.videoSeconds > 0 && e.provider === 'gemini') out = Math.max(out, MIN_OUTPUT.geminiNative);
  return input * inRate + big(out) * r.output + fee;
}

function worstArgs(o) {
  return {
    inputTokens: count(o.inputTokens, 'inputTokens', { required: true }),
    maxTokens: count(o.maxTokens, 'maxTokens', { required: true }),
    webSearches: count(o.webSearches, 'webSearches'),
    videoSeconds: count(o.videoSeconds, 'videoSeconds'),
    images: count(o.images, 'images'),
    imageDetail: o.imageDetail,
  };
}

/**
 * Worst-case cost of one chat call (one request / one round), in integer micro-dollars, rounded up, x MARGIN.
 * @param {object} o
 * @param {string} o.model        exact id, e.g. 'anthropic:claude-opus-5-5'
 * @param {number} o.inputTokens  estimated text input tokens (spec: ceil(bodyBytes / 3)); exclude base64 image/video bytes
 * @param {number} o.maxTokens    the max_tokens the server will send (thinking/reasoning is inside it)
 * @param {number} [o.webSearches]  Claude web searches allowed this request (max_uses x rounds); ignored for other providers
 * @param {number} [o.videoSeconds] seconds of attached Gemini video (native path); other models refuse it
 * @param {number} [o.images]       attached images, priced at the model's per-image ceiling
 * @param {'high'} [o.imageDetail]  'high' only if the server forces detail:"high" (gpt-6-astra: 3,000 instead of 36,000)
 * @param {boolean} [o.fallbacks=true]  false when the call runs without Anthropic's server-side fallback (A7b web calls)
 * @param {boolean} [o.margin=true]
 */
export function chatWorstCase(o = {}) {
  const e = entryOf(o.model, 'chat');
  const a = worstArgs(o);
  if (e.free) return 0;
  let pico = attemptWorst(o.model, a);
  if (e.fallbacks?.length && o.fallbacks !== false) pico += maxBig(...e.fallbacks.map((f) => attemptWorst(f, a)));
  return toMicros(pico, o.margin !== false);
}

/**
 * The largest max_tokens whose worst case stays within `budget` µ$ (spec §6's per-model cap). 0 means not even the
 * provider's minimum output fits, so the call must be refused.
 */
export function maxTokensWithin({ budget = PER_CALL_RESERVE_CAP, ceiling = 128_000, ...rest } = {}) {
  const fits = (m) => chatWorstCase({ ...rest, maxTokens: m }) <= budget;
  if (!fits(0)) return 0;
  let lo = 0, hi = count(ceiling, 'ceiling');
  if (fits(hi)) return hi;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid; }
  return lo;
}

const dayKey = (date) => {
  const d = date == null ? new Date() : new Date(date);
  if (Number.isNaN(d.getTime())) throw new PriceError('bad_input', 'date is not a valid date');
  return d.toISOString().slice(0, 10);
};
// The rates a settled request actually bills at: promo (by UTC date), else the lower tier when the prompt fits it.
function actualRates(model, promptTokens, date) {
  const R = RATES[model];
  if (R.promo && dayKey(date) <= R.promo.until) return R.promo;
  if (R.base && promptTokens <= R.base.upTo) return R.base;
  return R.top;
}

// Anthropic usage block (top level or one usage.iterations entry) → pico-dollars of tokens. A model with a lower tier
// (Haiku 5.5: up to 100K prompt tokens) bills at it when the whole prompt (fresh input + cache reads + writes) fits.
function anthropicTokens(model, u) {
  const created = field(u.cache_creation_input_tokens);
  const prompt = field(u.input_tokens) + field(u.cache_read_input_tokens) + created;
  const R = RATES[model], low = R.base && prompt <= R.base.upTo;
  const r = low ? R.base : R.top, w1Rate = low ? R.base.cacheWrite1h : R.cacheWrite1h;
  const split = u.cache_creation && typeof u.cache_creation === 'object';
  const w5 = split ? field(u.cache_creation.ephemeral_5m_input_tokens) : created; // no split: the code only writes 5-minute caches
  const w1 = split ? field(u.cache_creation.ephemeral_1h_input_tokens) : 0;
  const rest = Math.max(0, created - w5 - w1); // unexplained writes: price at the 1-hour rate
  return big(field(u.input_tokens)) * r.input + big(field(u.cache_read_input_tokens)) * r.cacheRead
    + big(w5) * r.cacheWrite + big(w1 + rest) * w1Rate + big(field(u.output_tokens)) * r.output;
}
const ANTHROPIC_IDS = Object.keys(PRICES).filter((k) => PRICES[k].kind === 'chat' && PRICES[k].provider === 'anthropic');
function anthropicActual(model, u) {
  const top = anthropicTokens(model, u);
  const iters = Array.isArray(u.iterations) ? u.iterations : [];
  let sum = 0n, searches = 0;
  for (const it of iters) {
    if (!it || typeof it !== 'object') continue;
    const id = String(it.model || '').startsWith('anthropic:') ? it.model : `anthropic:${it.model}`;
    // An unknown model in the chain is priced at the most expensive Anthropic rates in the table.
    sum += Object.hasOwn(RATES, id) && PRICES[id].provider === 'anthropic' ? anthropicTokens(id, it) : maxBig(...ANTHROPIC_IDS.map((k) => anthropicTokens(k, it)));
    searches += field(it.server_tool_use?.web_search_requests);
  }
  // Fallback: top-level usage covers only the attempt that answered, so the iterations sum is the bill. If iterations
  // are only a breakdown of the top level, the two are equal. Take the larger either way.
  searches = Math.max(searches, field(u.server_tool_use?.web_search_requests));
  return maxBig(top, sum) + big(searches) * (RATES[model].webSearch || usdPico(WEB_SEARCH_USD));
}

// Gemini native usageMetadata (streamGenerateContent). promptTokenCount includes cachedContentTokenCount.
function geminiActual(model, m, date) {
  const prompt = field(m.promptTokenCount), tool = field(m.toolUsePromptTokenCount);
  const cached = Math.min(field(m.cachedContentTokenCount), prompt);
  let out = field(m.candidatesTokenCount) + field(m.thoughtsTokenCount);
  const total = field(m.totalTokenCount);
  if (total) out = Math.max(out, total - prompt - tool);
  const r = actualRates(model, prompt + tool, date);
  return big(prompt - cached + tool) * r.input + big(cached) * r.cacheRead + big(out) * r.output;
}

// OpenAI-style usage (OpenAI, Gemini OpenAI-compat, Z.ai, DeepSeek, Meta). Responses-API names are accepted too.
function openaiActual(model, u, date) {
  const prompt = field(u.prompt_tokens ?? u.input_tokens);
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const cached = Math.min(field(d.cached_tokens ?? u.prompt_cache_hit_tokens), prompt);
  const od = u.completion_tokens_details || u.output_tokens_details || {};
  const total = field(u.total_tokens);
  // Some providers leave reasoning out of completion_tokens but count it in total_tokens.
  const out = Math.max(field(u.completion_tokens ?? u.output_tokens), field(od.reasoning_tokens), total ? total - prompt : 0);
  const r = actualRates(model, prompt, date);
  const uncached = prompt - cached;
  const reported = d.cache_write_tokens ?? d.cache_creation_tokens ?? d.cache_creation_input_tokens;
  let input;
  if (reported !== undefined && reported !== null) {
    const w = Math.min(field(reported), uncached);
    input = big(w) * r.cacheWrite + big(uncached - w) * r.input;
  } else {
    input = big(uncached) * maxBig(r.input, r.cacheWrite); // writes not reported: assume every fresh token was written
  }
  return input + big(cached) * r.cacheRead + big(out) * r.output;
}

/**
 * Actual cost of a finished chat call from the provider's reported usage, in integer micro-dollars, rounded up
 * (no margin unless `margin: true`). Throws PriceError('no_usage') when usage is missing: keep the full reservation.
 * @param {object} o
 * @param {string} o.model   the requested model id (Anthropic usage.iterations entries are priced per model)
 * @param {object|object[]} o.usage  Anthropic `usage` (incl. cache tokens, cache_creation split, server_tool_use,
 *   iterations), OpenAI-style `usage`, or Gemini `usageMetadata` (or a response object holding it). An array sums
 *   several rounds (e.g. pause_turn continuations).
 * @param {Date|string|number} [o.date]  when the request ran (Gemini 3.8 Flash promo pricing); default now
 */
export function chatActual(o = {}) {
  const e = entryOf(o.model, 'chat');
  const list = Array.isArray(o.usage) ? o.usage : [o.usage];
  if (!list.length || list.some((u) => !u || typeof u !== 'object')) throw new PriceError('no_usage', 'No usage reported');
  if (e.free) return 0;
  let pico = 0n;
  for (const u of list) {
    if (e.provider === 'anthropic') pico += anthropicActual(o.model, u);
    else if (e.provider === 'gemini' && (u.usageMetadata || 'promptTokenCount' in u)) pico += geminiActual(o.model, u.usageMetadata || u, o.date);
    else pico += openaiActual(o.model, u, o.date);
  }
  return toMicros(pico, o.margin === true);
}

// ───────────────────────────── images ─────────────────────────────
/**
 * GPT Image 2 / 2.5 output tokens for one image: OpenAI's published GptImageTokenCalculator formula
 * (developers.openai.com image-generation guide, "GPT Image 2.5 and GPT Image 2 output tokens"; it covers Sunburst and Flare).
 */
const GPT_IMAGE_BASE = Object.freeze({ low: 16, medium: 24, high: 48, xhigh: 64, max: 96 });
export function gptImageOutputTokens(width, height, quality) {
  const o = GPT_IMAGE_BASE[quality];
  if (!o) throw new PriceError('bad_quality', `Unsupported GPT Image quality "${quality}"`);
  const i = Math.max(width, height), a = Math.min(width, height);
  const s = o / (i / a), l = Math.floor(s), u = s - l === 0.5 ? l + (l % 2) : Math.round(s);
  const d = (width >= height ? o : u) * (width >= height ? u : o);
  return Math.ceil((d * (2e6 + width * height)) / 4e6);
}

function imagePico(model, e, o) {
  const n = count(o.n ?? 1, 'n');
  if (n < 1) throw new PriceError('bad_input', 'n must be at least 1');
  if (e.free) return 0n;
  if (e.perImageUsd) {
    if (o.size !== undefined && !e.sizes.includes(o.size)) throw new PriceError('bad_size', `${model} has no size "${o.size}"`);
    return big(n) * usdPico(e.perImageUsd);
  }
  const promptTokens = count(o.promptTokens ?? DEFAULT_IMAGE_PROMPT_TOKENS, 'promptTokens');
  const inputImages = count(o.inputImages, 'inputImages');
  if (e.provider === 'openai') {
    if (!e.sizes.includes(o.size)) throw new PriceError('bad_size', `${model} size must be one of ${e.sizes.join(', ')}`);
    if (!e.qualities.includes(o.quality)) throw new PriceError('bad_quality', `${model} quality must be one of ${e.qualities.join(', ')}`);
    const [w, h] = o.size.split('x').map(Number);
    const outPerImage = gptImageOutputTokens(w, h, o.quality) + 100 * count(o.partialImages, 'partialImages');
    return big(promptTokens) * perToken(e.textInput) + big(inputImages * OPENAI_EDIT_IMAGE_TOKENS) * perToken(e.imageInput)
      + big(n * outPerImage) * perToken(e.imageOutput);
  }
  // Gemini: one image per request; every request bills its own input, thinking allowance and image.
  if (!Object.hasOwn(e.imageTokens, o.size)) throw new PriceError('bad_size', `${model} imageSize must be one of ${Object.keys(e.imageTokens).join(', ')}`);
  const thinking = count(o.thinkingTokens ?? e.thinkingTokens, 'thinkingTokens');
  const perRequest = big(promptTokens) * perToken(e.textInput) + big(inputImages * e.inputImageTokens) * perToken(e.imageInput)
    + big(e.imageTokens[o.size]) * perToken(e.imageOutput) + big(thinking) * perToken(e.textOutput);
  return big(n) * perRequest;
}

/**
 * Worst-case cost of an image request, in integer micro-dollars, rounded up, x MARGIN.
 * @param {object} o
 * @param {string} o.model   e.g. 'openai:gpt-image-2.5-flare', 'gemini:gemini-3-pro-image', 'meta:muse-image-1.0'
 * @param {number} [o.n=1]   images (OpenAI/Meta: one request; Gemini: n separate requests)
 * @param {string} o.size    OpenAI/Meta 'WxH' from the model's `sizes`; Gemini imageSize '1K' | '2K' | '4K'
 * @param {string} [o.quality] OpenAI only: low | medium | high | xhigh | max ('auto' is refused)
 * @param {number} [o.promptTokens=DEFAULT_IMAGE_PROMPT_TOKENS]  prompt text tokens (pass ceil(promptBytes / 3))
 * @param {number} [o.inputImages=0]   reference images sent for an edit
 * @param {number} [o.partialImages=0] OpenAI streamed partial images per image (+100 output tokens each)
 * @param {number} [o.thinkingTokens]  Gemini thinking/text allowance per request (defaults to the model's)
 * @param {boolean} [o.margin=true]
 */
export function imageCost(o = {}) {
  const e = entryOf(o.model, 'image');
  return toMicros(imagePico(o.model, e, o), o.margin !== false);
}

/**
 * Actual cost of an image request from reported usage (settle; no margin unless `margin: true`).
 * OpenAI Images `usage`, Gemini `usageMetadata` (or the response). Meta bills per image (pass n); FLUX is $0.
 */
export function imageActual(o = {}) {
  const e = entryOf(o.model, 'image');
  if (e.free) return 0;
  if (e.perImageUsd) return toMicros(big(count(o.n ?? 1, 'n')) * usdPico(e.perImageUsd), o.margin === true);
  const u = o.usage && typeof o.usage === 'object' ? (o.usage.usageMetadata || o.usage) : null;
  if (!u) throw new PriceError('no_usage', 'No usage reported');
  let pico;
  if (e.provider === 'openai') {
    const d = u.input_tokens_details || {};
    const input = field(u.input_tokens);
    const text = Math.min(field(d.text_tokens), input), img = Math.min(field(d.image_tokens), input - text);
    const unknown = input - text - img; // unexplained input: price at the dearer image-input rate
    pico = big(text) * perToken(e.textInput) + big(img + unknown) * perToken(e.imageInput) + big(field(u.output_tokens)) * perToken(e.imageOutput);
  } else {
    const prompt = field(u.promptTokenCount);
    const details = Array.isArray(u.candidatesTokensDetails) ? u.candidatesTokensDetails : null;
    const cand = field(u.candidatesTokenCount);
    const image = details ? Math.min(details.filter((x) => x?.modality === 'IMAGE').reduce((s, x) => s + field(x.tokenCount), 0), cand) : cand;
    const text = cand - image + field(u.thoughtsTokenCount);
    const total = field(u.totalTokenCount);
    const extra = total ? Math.max(0, total - prompt - cand - field(u.thoughtsTokenCount)) : 0; // unexplained: image rate
    pico = big(prompt) * maxBig(perToken(e.textInput), perToken(e.imageInput)) + big(image + extra) * perToken(e.imageOutput) + big(text) * perToken(e.textOutput);
  }
  return toMicros(pico, o.margin === true);
}

// ───────────────────────────── video ─────────────────────────────
/**
 * Veo cost: seconds x per-second price (x MARGIN by default). Without `resolution` the dearest one is used.
 * Free video models (Cosmos, the motion still) cost 0. Veo bills only when a video is generated: settle failures at 0.
 */
export function veoCost(o = {}) {
  const e = entryOf(o.model, 'video');
  const seconds = count(o.seconds, 'seconds', { required: true });
  if (e.free) return 0;
  if (seconds < 1) throw new PriceError('bad_input', 'seconds must be at least 1');
  let usd;
  if (o.resolution === undefined) usd = Math.max(...Object.values(e.perSecond));
  else if (Object.hasOwn(e.perSecond, o.resolution)) usd = e.perSecond[o.resolution];
  else throw new PriceError('bad_resolution', `${o.model} resolution must be one of ${Object.keys(e.perSecond).join(', ')}`);
  return toMicros(big(seconds) * usdPico(usd), o.margin !== false);
}

/**
 * Actual cost of a finished Gemini Omni video from the interaction's `usage` (settle; no margin unless `margin: true`):
 * total_input_tokens at the input rate, the video tokens (output_tokens_by_modality, modality "video") at the video
 * rate and the rest of total_output_tokens (thinking, text) at the text rate. Throws PriceError('no_usage') when there
 * is no output count: settle at the per-second price instead (veoCost with margin: false).
 * @param {object} o
 * @param {string} o.model  'gemini:gemini-omni-1.1-flash'
 * @param {object} o.usage  {total_input_tokens, total_output_tokens, output_tokens_by_modality: [{modality, tokens}]}
 */
export function omniActual(o = {}) {
  const e = entryOf(o.model, 'video');
  if (!e.omni) throw new PriceError('wrong_kind', `"${o.model}" is not billed by tokens`);
  const u = o.usage && typeof o.usage === 'object' ? o.usage : null;
  const byModality = Array.isArray(u?.output_tokens_by_modality) ? u.output_tokens_by_modality : [];
  let video = byModality.filter((x) => String(x?.modality || '').toLowerCase() === 'video').reduce((n, x) => n + field(x.tokens), 0);
  const out = Math.max(field(u?.total_output_tokens), video);
  if (!u || !out) throw new PriceError('no_usage', 'No output tokens reported');
  if (!byModality.length) video = out; // no breakdown: every output token at the (dearest) video rate
  return toMicros(big(field(u.total_input_tokens)) * perToken(e.input) + big(video) * perToken(e.videoOutput) + big(out - video) * perToken(e.textOutput), o.margin === true);
}

// ───────────────────────────── speech (read aloud) ─────────────────────────────
/**
 * The audio one read-aloud reservation pays for → {units, seconds, audioTokens}: seconds = ceil(units /
 * TTS_MIN_CHARS_PER_SECOND), audioTokens = seconds x the reserve rate (reserveTokensPerSecond, else
 * audioTokensPerSecond), at most maxAudioTokens. The tester router holds the provider to it: Gemini's maxOutputTokens
 * is audioTokens. Takes the same input as ttsWorstCase (margin is ignored).
 */
export function ttsReserved(o = {}) {
  const e = entryOf(o.model, 'tts');
  const chars = count(o.chars, 'chars', { required: true });
  const units = Math.max(chars, count(o.units, 'units'));
  const seconds = Math.ceil(units / TTS_MIN_CHARS_PER_SECOND);
  // Reservations (and Gemini's maxOutputTokens) use reserveTokensPerSecond when set: Sulafat speaks ≈ 31.8 tokens/s live, so
  // holding it to the published 25/s cut slow reads short. Settling still uses the published rate as its floor.
  let audioTokens = seconds * (e.reserveTokensPerSecond ?? e.audioTokensPerSecond);
  if (o.maxAudioTokens !== undefined && o.maxAudioTokens !== null) audioTokens = Math.min(audioTokens, count(o.maxAudioTokens, 'maxAudioTokens'));
  return { units, seconds, audioTokens };
}

/**
 * Worst-case cost of one read-aloud request, in integer micro-dollars, rounded up, x MARGIN:
 * ceil(units / TTS_MIN_CHARS_PER_SECOND) seconds x audio tokens per second at the audio rate (at most maxAudioTokens
 * when the request bounds its output), plus (ceil(units / 3) + TTS_INSTRUCTION_TOKENS) input tokens at the text rate.
 * units is a ceiling on the reading time (src/tts.js ttsCeilingUnits: digits, symbols, emoji and CJK characters weigh
 * more than a letter); without it, chars. Priced at the standing price, never the promo.
 * @param {object} o
 * @param {string} o.model  'gemini:gemini-3.8-flash-tts' | 'gemini:gemini-3.8-flash-lite-tts'
 * @param {number} o.chars  characters of text to speak
 * @param {number} [o.units] reading-time units of that text (at least chars)
 * @param {number} [o.maxAudioTokens] the request's own output bound (Gemini maxOutputTokens): a true ceiling
 * @param {boolean} [o.margin=true]
 */
export function ttsWorstCase(o = {}) {
  const { units, audioTokens } = ttsReserved(o);
  const r = TTS_RATES[o.model].top;
  const input = Math.ceil(units / 3) + TTS_INSTRUCTION_TOKENS;
  return toMicros(big(input) * r.input + big(audioTokens) * r.audio, o.margin !== false);
}

/**
 * Actual cost of a finished read-aloud request (settle; no margin unless `margin: true`).
 * Audio = max(the reported candidates tokens, seconds x 25 tokens/s): the published 25/s is a floor (a live read
 * reported ≈ 31.8/s); input = usageMetadata.promptTokenCount, else estimated from `chars`. Promo prices for requests
 * dated through 2026-12-31 (UTC), then the standing price. `maxAudioTokens`, the request's own output bound (a tester's
 * maxOutputTokens), caps the seconds estimate (the provider can't bill audio past it), never the reported count.
 * Throws PriceError('no_usage') when there is neither usage nor seconds: keep the full reservation.
 * @param {object} o
 * @param {string} o.model
 * @param {object} [o.usage]   Gemini usageMetadata (or a response holding it)
 * @param {number} [o.seconds] seconds of audio returned
 * @param {number} [o.chars]   characters sent, when usage is missing
 * @param {number} [o.maxAudioTokens] the request's output bound, if it sent one
 * @param {Date|string|number} [o.date]  when the request ran; default now
 */
export function ttsActual(o = {}) {
  const e = entryOf(o.model, 'tts');
  const R = TTS_RATES[o.model];
  const u = o.usage && typeof o.usage === 'object' ? (o.usage.usageMetadata || o.usage) : null;
  const hasSeconds = o.seconds !== undefined && o.seconds !== null;
  // The audio the seconds account for, at the model's token rate, at most the request's own output bound.
  let fromSeconds = 0;
  if (hasSeconds) {
    const s = Number(o.seconds);
    if (typeof o.seconds === 'boolean' || !Number.isFinite(s) || s < 0) throw new PriceError('bad_input', 'seconds must be a number >= 0');
    fromSeconds = Math.ceil(s * e.audioTokensPerSecond - 1e-9);
  }
  if (o.maxAudioTokens !== undefined && o.maxAudioTokens !== null) fromSeconds = Math.min(fromSeconds, count(o.maxAudioTokens, 'maxAudioTokens'));
  if (!u && !hasSeconds) throw new PriceError('no_usage', 'No usage or audio length reported');
  const r = R.promo && dayKey(o.date) <= R.promo.until ? R.promo : R.top;
  const prompt = u ? field(u.promptTokenCount) : 0;
  const reported = u ? Math.max(field(u.candidatesTokenCount) + field(u.thoughtsTokenCount), field(u.totalTokenCount) ? field(u.totalTokenCount) - prompt : 0) : 0;
  const input = prompt || (o.chars != null ? Math.ceil(count(o.chars, 'chars') / 3) + TTS_INSTRUCTION_TOKENS : 0);
  // The reported count is what Google bills (≈ 31.8 tokens/s observed); seconds x 25 is the floor when it reports less.
  return toMicros(big(input) * r.input + big(Math.max(reported, fromSeconds)) * r.audio, o.margin === true);
}

// ───────────────────────────── dictation (speech to text) ─────────────────────────────
/**
 * The seconds a duration-billed dictation (gpt-transcribe) is reserved for: the WAV's own length when it is known,
 * else the recording's bytes at STT_MIN_BYTES_PER_SECOND (a ceiling on how long it can play). Rounded up.
 */
export function sttCeilingSeconds({ seconds = null, bytes = 0 } = {}) {
  if (seconds != null) return Math.max(1, count(seconds, 'seconds'));
  return Math.max(1, Math.ceil(count(bytes, 'bytes') / STT_MIN_BYTES_PER_SECOND));
}

/**
 * Worst-case cost of one dictation request, in integer micro-dollars, rounded up, x MARGIN.
 * OpenAI gpt-transcribe: billed by duration, so sttCeilingSeconds({seconds, bytes}) x $0.0045 a minute.
 * Gemini: inputTokens (src/transcribe.js: the WAV's seconds x 32 plus the instructions, or the 3-minute cap that Gemini's countTokens then checks)
 *   plus maxOutputTokens (the bound the request sends; thinking is inside it). Both are required.
 * @param {object} o
 * @param {string} o.model  'openai:gpt-transcribe' | 'gemini:gemini-3.5-flash-lite#stt'
 * @param {number} [o.seconds]          OpenAI: the WAV's measured length (null when unknown)
 * @param {number} [o.bytes]            OpenAI: the recording's size, for a length that can't be measured
 * @param {number} [o.inputTokens]      Gemini: input tokens at most
 * @param {number} [o.maxOutputTokens]  Gemini: the request's output bound
 * @param {boolean} [o.margin=true]
 */
export function sttWorstCase(o = {}) {
  const e = entryOf(o.model, 'stt');
  const r = STT_RATES[o.model];
  if (e.perMinute) {
    if (o.seconds == null && o.bytes == null) throw new PriceError('bad_input', 'seconds or bytes is required');
    return toMicros(big(sttCeilingSeconds(o)) * r.perSecond, o.margin !== false);
  }
  const input = count(o.inputTokens, 'inputTokens', { required: true });
  const output = count(o.maxOutputTokens, 'maxOutputTokens', { required: true });
  return toMicros(big(input) * r.input + big(output) * r.output, o.margin !== false);
}

/**
 * Actual cost of a finished dictation request (settle; no margin unless `margin: true`).
 * OpenAI gpt-transcribe (duration-billed): usage {type: "duration", seconds}, rounded up to the second; when the answer
 * reports tokens instead (or nothing), the WAV's measured `seconds`. Gemini: usageMetadata {promptTokenCount,
 * candidatesTokenCount, thoughtsTokenCount, totalTokenCount} (or a response holding it). Throws PriceError('no_usage')
 * when neither gives a count: keep the full reservation.
 * @param {object} o
 * @param {string} o.model
 * @param {object} o.usage
 * @param {number} [o.seconds]  OpenAI: the WAV's measured length, used only when usage has no duration
 * @param {boolean} [o.margin=false]
 */
export function sttActual(o = {}) {
  const e = entryOf(o.model, 'stt');
  const r = STT_RATES[o.model];
  const u = o.usage && typeof o.usage === 'object' ? (o.usage.usageMetadata || o.usage) : null;
  if (e.perMinute) {
    const billed = u?.type === 'duration' && Number(u.seconds) >= 0 ? Number(u.seconds) : o.seconds != null ? Number(o.seconds) : NaN;
    if (!Number.isFinite(billed) || billed < 0) throw new PriceError('no_usage', 'No billed duration reported');
    return toMicros(big(Math.ceil(billed - 1e-9)) * r.perSecond, o.margin === true);
  }
  if (!u) throw new PriceError('no_usage', 'No usage reported');
  const input = field(u.promptTokenCount);
  const output = Math.max(field(u.candidatesTokenCount) + field(u.thoughtsTokenCount), field(u.totalTokenCount) ? field(u.totalTokenCount) - input : 0);
  if (!input) throw new PriceError('no_usage', 'No input tokens reported');
  return toMicros(big(input) * r.input + big(output) * r.output, o.margin === true);
}
