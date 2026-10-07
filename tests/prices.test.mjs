import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES_CHECKED, MARGIN, PRICES, PER_CALL_RESERVE_CAP, WEB_SEARCH_RESULT_TOKENS, GEMINI_VIDEO_TOKENS_PER_SECOND,
  TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS, TESTER_EXCLUDED, WEB_CALL_RESERVE_CAP, VEO_CALL_RESERVE_CAP,
  chatWorstCase, chatActual, imageCost, imageActual, veoCost, omniActual, maxTokensWithin, gptImageOutputTokens, OMNI_TOKENS_PER_SECOND,
  priceOf, isFree, PriceError,
  TESTER_TTS_MODELS, ttsWorstCase, ttsReserved, ttsActual, TTS_MIN_CHARS_PER_SECOND, TTS_INSTRUCTION_TOKENS,
} from '../src/tester/prices.js';
import { TESTER_STT_MODELS, sttWorstCase, sttActual, sttCeilingSeconds, STT_MIN_BYTES_PER_SECOND } from '../src/tester/prices.js';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof PriceError && e.code === code, `expected PriceError ${code}`);
const AFTER_PROMO = '2027-01-02T12:00:00Z';

test('header constants: checked date, margin, per-call caps', () => {
  assert.equal(PRICES_CHECKED, '2026-10-07');
  assert.equal(MARGIN, 1.25);
  assert.equal(PER_CALL_RESERVE_CAP, 250_000);
  assert.equal(WEB_CALL_RESERVE_CAP, 500_000);
  assert.equal(VEO_CALL_RESERVE_CAP, 1_000_000);
});

test('the table is deeply frozen', () => {
  assert.ok(Object.isFrozen(PRICES));
  assert.ok(Object.isFrozen(PRICES['anthropic:claude-opus-5-5']));
  assert.ok(Object.isFrozen(PRICES['openai:gpt-6-astra'].base));
  assert.ok(Object.isFrozen(TESTER_MODELS) && Object.isFrozen(TESTER_IMAGE_MODELS) && Object.isFrozen(TESTER_VIDEO_MODELS));
  assert.throws(() => { PRICES['anthropic:claude-opus-5-5'].input = 0; }, TypeError);
  assert.throws(() => { TESTER_MODELS.push('x'); }, TypeError);
});

test('every TESTER_* model has a price of the right kind and a source', () => {
  const nonNeg = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const [list, kind] of [[TESTER_MODELS, 'chat'], [TESTER_IMAGE_MODELS, 'image'], [TESTER_VIDEO_MODELS, 'video'], [TESTER_TTS_MODELS, 'tts'], [TESTER_STT_MODELS, 'stt']]) {
    assert.ok(list.length > 0, `${kind} list is empty`);
    for (const id of list) {
      const e = priceOf(id);
      assert.ok(e, `${id} has no price`);
      assert.equal(e.kind, kind, `${id} kind`);
      assert.notEqual(e.tester, false, `${id} is excluded but listed`);
      assert.ok(typeof e.source === 'string' && e.source.length > 10, `${id} source`);
      if (e.provider !== 'local') assert.match(e.source, /^https:\/\//, `${id} source URL`);
      if (kind === 'chat') for (const k of ['input', 'output', 'cacheWrite', 'cacheRead']) assert.ok(nonNeg(e[k]), `${id}.${k}`);
      if (kind === 'chat' && !e.free) assert.ok(e.input > 0 && e.output > 0, `${id} paid model priced at 0`);
      if (kind === 'image' && !e.free) assert.ok(e.perImageUsd > 0 || (e.imageOutput > 0 && e.textInput > 0), `${id} image price`);
      if (kind === 'video' && !e.free) assert.ok(Object.values(e.perSecond).every((v) => v > 0), `${id} per-second price`);
      // Every listed model can actually be priced by its cost function.
      if (kind === 'chat') assert.ok(Number.isInteger(chatWorstCase({ model: id, inputTokens: 100, maxTokens: 100 })));
      if (kind === 'video') assert.ok(Number.isInteger(veoCost({ model: id, seconds: 4 })));
      if (kind === 'tts') {
        assert.ok(e.textInput > 0 && e.audioOutput > 0 && e.audioTokensPerSecond > 0, `${id} speech price`);
        assert.ok(Number.isInteger(ttsWorstCase({ model: id, chars: 100 })) && ttsWorstCase({ model: id, chars: 100 }) > 0);
      }
      if (kind === 'stt') {
        assert.ok(e.perMinute > 0 || (e.input > 0 && e.output > 0), `${id} dictation price`);
        const w = sttWorstCase({ model: id, inputTokens: 1_000, maxOutputTokens: 1_000, seconds: 180, bytes: 1_000 });
        assert.ok(Number.isInteger(w) && w > 0 && w <= PER_CALL_RESERVE_CAP, id);
      }
      if (kind === 'image' && !e.free) {
        const size = e.provider === 'gemini' ? '2K' : e.sizes[0];
        assert.ok(imageCost({ model: id, size, quality: e.qualities ? 'medium' : undefined }) > 0);
      }
    }
  }
});

test('the app\'s paid models are listed for testers; fallback-only targets and retired ids are not', () => {
  for (const id of ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5', 'anthropic:claude-fable-5-1', 'openai:gpt-6-luna',
    'openai:gpt-6-astra', 'openai:gpt-6.1-sol', 'gemini:gemini-3.8-flash', 'gemini:gemini-3.1-pro-preview', 'gemini:gemini-3.5-flash-lite',
    'zai:glm-5.3', 'zai:glm-5.3-flash', 'deepseek:deepseek-flash', 'deepseek:deepseek-v4-pro', 'meta:muse-spark-1.3']) {
    assert.ok(TESTER_MODELS.includes(id), id);
  }
  // Addendum A7b: no free model for testers (NVIDIA, Z.ai's free tier, FLUX, Cosmos, the motion still).
  for (const list of [TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS]) for (const id of list) assert.ok(!isFree(id), `${id} is free`);
  for (const id of ['zai:glm-4.7-flash', 'moonshotai/kimi-k3', 'black-forest-labs/flux.1-dev', 'nvidia/cosmos3-nano', 'atelier/motion-still']) {
    assert.ok(![...TESTER_MODELS, ...TESTER_IMAGE_MODELS, ...TESTER_VIDEO_MODELS].includes(id), id);
    assert.match(TESTER_EXCLUDED[id], /free/);
  }
  for (const id of ['anthropic:claude-opus-5', 'anthropic:claude-opus-4-8', 'anthropic:claude-sonnet-5']) {
    assert.ok(!TESTER_MODELS.includes(id), id);
    assert.ok(priceOf(id), `${id} still priced for settle`);
    assert.match(TESTER_EXCLUDED[id], /fallback/);
  }
  // Veo 3.1 on the Gemini API shuts down 2026-10-22: Gemini Omni is the only priced Google video model. Runway video
  // (Veo 3.1 included) is owner-only and never priced for testers. Retired ids are gone from the table.
  assert.deepEqual([...TESTER_VIDEO_MODELS], ['gemini:gemini-omni-1.1-flash']);
  for (const id of ['gemini:veo-3.1-generate-preview', 'gemini:veo-3.1-fast-generate-preview', 'gemini:veo-3.1-lite-generate-preview', 'gemini:gemini-3.1-flash-image',
    'runway:veo3.1', 'runway:veo3.1_fast', 'runway:gen4.5', 'deepseek:deepseek-chat', 'deepseek:deepseek-reasoner', 'deepseek:deepseek-v4-flash', 'openai:gpt-image-1']) {
    assert.equal(priceOf(id), null, id);
  }
  assert.ok(TESTER_IMAGE_MODELS.includes('gemini:gemini-nano-banana-2.1'));
  assert.ok(TESTER_IMAGE_MODELS.includes('openai:gpt-image-2.5-sunburst'));
});

test('costs round UP to whole micro-dollars', () => {
  // Gemini 3.5 Flash-Lite input is $0.30/MTok = 0.3 µ$/token.
  assert.equal(chatWorstCase({ model: 'gemini:gemini-3.5-flash-lite', inputTokens: 1, maxTokens: 0 }), 1); // 0.375 → 1
  assert.equal(chatWorstCase({ model: 'gemini:gemini-3.5-flash-lite', inputTokens: 3, maxTokens: 0 }), 2); // 1.125 → 2
  assert.equal(chatWorstCase({ model: 'gemini:gemini-3.5-flash-lite', inputTokens: 1, maxTokens: 0, margin: false }), 1); // 0.3 → 1
  assert.equal(chatActual({ model: 'gemini:gemini-3.5-flash-lite', usage: { prompt_tokens: 1, completion_tokens: 0 } }), 1);
  // 1000 x $5 + 439 x $30 per MTok = 18,170 µ$; x 1.25 = 22,712.5 → 22,713.
  assert.equal(imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'medium', promptTokens: 1000 }), 22_713);
  // Fractional token counts are rounded up before pricing.
  assert.equal(chatWorstCase({ model: 'zai:glm-5.3', inputTokens: 0.2, maxTokens: 0, margin: false }), 2); // 1 token x 1.4 → 2
  for (const v of [chatWorstCase({ model: 'deepseek:deepseek-flash', inputTokens: 7, maxTokens: 3 }), veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: 4 })]) {
    assert.ok(Number.isInteger(v));
  }
});

test('reserve functions apply the 1.25 margin; settle functions do not unless asked', () => {
  assert.equal(imageCost({ model: 'meta:muse-image-1.0' }), 12_500);
  assert.equal(imageCost({ model: 'meta:muse-image-1.0', margin: false }), 10_000);
  assert.equal(veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: 4, resolution: '720p' }), 506_800);
  assert.equal(veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: 4, resolution: '720p', margin: false }), 405_440);
  const args = { model: 'anthropic:claude-opus-5-5', inputTokens: 10_000, maxTokens: 4_000 };
  assert.equal(chatWorstCase({ ...args, margin: false }), 292_500);
  assert.equal(chatWorstCase(args), 365_625); // exactly 292,500 x 1.25
  const usage = { prompt_tokens: 1000, completion_tokens: 1000 };
  assert.equal(chatActual({ model: 'zai:glm-5.3', usage }), 5_800); // 1000 x 1.4 + 1000 x 4.4
  assert.equal(chatActual({ model: 'zai:glm-5.3', usage, margin: true }), 7_250);
});

test('chat worst case: hand-checked values', () => {
  // Opus 5.5: primary 10,000 x $5 (5-min cache write) + 4,000 x $20 = 130,000; plus the dearer fallback
  // (Opus 5 / Opus 4.8): 10,000 x $6.25 + 4,000 x $25 = 162,500. Total 292,500 → x1.25.
  assert.equal(chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 10_000, maxTokens: 4_000 }), 365_625);
  // Sonnet 5.5 + Sonnet 5 fallback: 2 x (10,000 x $2.50 + 4,000 x $10) = 130,000 → 162,500.
  assert.equal(chatWorstCase({ model: 'anthropic:claude-sonnet-5-5', inputTokens: 10_000, maxTokens: 4_000 }), 162_500);
  // GPT-6 Astra worst case uses the long-context cache-write rate ($25) and long output ($75).
  assert.equal(chatWorstCase({ model: 'openai:gpt-6-astra', inputTokens: 1_000, maxTokens: 1_000 }), 125_000);
  // Gemini 3.8 Flash at the 2027 rate, 180 s of video at 332 tokens/s: (1,000 + 59,760) x $1.50 + 1,000 x $7.50.
  assert.equal(GEMINI_VIDEO_TOKENS_PER_SECOND, 332);
  assert.equal(chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: 1_000, maxTokens: 1_000, videoSeconds: 180 }), 123_300);
  // Gemini 3.1 Pro uses the >200K tier ($4 / $18).
  assert.equal(chatWorstCase({ model: 'gemini:gemini-3.1-pro-preview', inputTokens: 1_000, maxTokens: 1_000, margin: false }), 22_000);
});

test('Anthropic: fallback attempt is reserved on top of the primary, and max_tokens has the 1024 floor', () => {
  const opus = chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 5_000, maxTokens: 2_000, margin: false });
  const opus5 = chatWorstCase({ model: 'anthropic:claude-opus-4-8', inputTokens: 5_000, maxTokens: 2_000, margin: false });
  assert.equal(opus, 5_000 * 5 + 2_000 * 20 + opus5);
  // Fable 5.1 falls back to the $5/$25 Opus models.
  assert.equal(chatWorstCase({ model: 'anthropic:claude-fable-5-1', inputTokens: 0, maxTokens: 2_000, margin: false }), 2_000 * 50 + 2_000 * 25);
  // anthropic.js clamps max_tokens to at least 1024, so a smaller cap reserves as 1024.
  const at = (m) => chatWorstCase({ model: 'anthropic:claude-sonnet-5-5', inputTokens: 100, maxTokens: m });
  assert.equal(at(1), at(1024));
  assert.ok(at(1025) > at(1024));
  // fallbacks:false (tester web calls) reserves the primary attempt only.
  const solo = chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 5_000, maxTokens: 2_000, fallbacks: false, margin: false });
  assert.equal(solo, 5_000 * 5 + 2_000 * 20);
  assert.equal(chatWorstCase({ model: 'openai:gpt-6-luna', inputTokens: 5, maxTokens: 5, fallbacks: false }), chatWorstCase({ model: 'openai:gpt-6-luna', inputTokens: 5, maxTokens: 5 }));
});

test('web search: fee plus result tokens on Claude; ignored for providers that cannot search', () => {
  const base = { model: 'anthropic:claude-sonnet-5-5', inputTokens: 1_000, maxTokens: 1_024 };
  // Per attempt: input (2 x 1,000 + 25,000) x $2.50 = 67,500; fee 10,000; output 1,024 x $10 = 10,240.
  // Two attempts (Sonnet 5.5 + Sonnet 5 fallback) = 175,480 → x1.25.
  assert.equal(WEB_SEARCH_RESULT_TOKENS, 25_000);
  assert.equal(chatWorstCase({ ...base, webSearches: 1 }), 219_350);
  const none = chatWorstCase({ ...base, margin: false });
  const one = chatWorstCase({ ...base, webSearches: 1, margin: false });
  assert.ok(one - none >= 2 * 10_000, 'the $0.01 fee is reserved for each attempt');
  assert.ok(chatWorstCase({ ...base, webSearches: 3 }) > chatWorstCase({ ...base, webSearches: 1 }));
  for (const model of ['gemini:gemini-3.8-flash', 'openai:gpt-6-luna', 'moonshotai/kimi-k3']) {
    assert.equal(chatWorstCase({ model, inputTokens: 500, maxTokens: 500, webSearches: 3 }), chatWorstCase({ model, inputTokens: 500, maxTokens: 500 }));
  }
});

test('images and video in chat: priced where a rule is published, refused otherwise', () => {
  const opus0 = chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 0, maxTokens: 1024, margin: false });
  const opus1 = chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 0, maxTokens: 1024, images: 1, margin: false });
  assert.equal(opus1 - opus0, 4_784 * 5 + 4_784 * 6.25); // primary + fallback, each at the 4,784-token ceiling
  const astra = (o) => chatWorstCase({ model: 'openai:gpt-6-astra', inputTokens: 0, maxTokens: 0, images: 1, margin: false, ...o });
  assert.equal(astra(), 36_000 * 25);
  assert.equal(astra({ imageDetail: 'high' }), 3_000 * 25);
  throwsCode(() => chatWorstCase({ model: 'openai:gpt-6-luna', inputTokens: 10, maxTokens: 10, images: 1 }), 'unpriced_images');
  throwsCode(() => chatWorstCase({ model: 'deepseek:deepseek-flash', inputTokens: 10, maxTokens: 10, images: 1 }), 'unpriced_images');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', inputTokens: 10, maxTokens: 10, images: 1 }), 'no_vision');
  throwsCode(() => chatWorstCase({ model: 'deepseek:deepseek-v4-pro', inputTokens: 10, maxTokens: 10, images: 2 }), 'no_vision');
  throwsCode(() => chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 10, maxTokens: 10, videoSeconds: 30 }), 'no_video');
  // Free NVIDIA models cost nothing whatever is attached.
  assert.equal(chatWorstCase({ model: 'meta/llama-3.2-90b-vision-instruct', inputTokens: 10, maxTokens: 10, images: 4 }), 0);
  // gemini.js raises a native video chat's max_tokens to at least 256.
  const vid = (m) => chatWorstCase({ model: 'gemini:gemini-3.5-flash-lite', inputTokens: 0, maxTokens: m, videoSeconds: 10 });
  assert.equal(vid(1), vid(256));
});

test('chatActual: Anthropic cache tokens, 5-minute / 1-hour split, web searches and rounds', () => {
  const model = 'anthropic:claude-opus-5-5';
  const usage = {
    input_tokens: 1_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 20_000,
    cache_creation: { ephemeral_5m_input_tokens: 15_000, ephemeral_1h_input_tokens: 5_000 }, output_tokens: 2_000,
  };
  // 1,000 x $4 + 100,000 x $0.20 + 15,000 x $5 + 5,000 x $8 + 2,000 x $20
  assert.equal(chatActual({ model, usage }), 4_000 + 20_000 + 75_000 + 40_000 + 40_000);
  // Without the split, writes are the 5-minute kind the code requests.
  const { cache_creation, ...noSplit } = usage;
  assert.equal(chatActual({ model, usage: noSplit }), 4_000 + 20_000 + 100_000 + 40_000);
  // Web search fee: $0.01 each.
  assert.equal(chatActual({ model, usage: { ...noSplit, server_tool_use: { web_search_requests: 2 } } }), 164_000 + 20_000);
  // Several rounds (pause_turn continuation) are summed.
  assert.equal(chatActual({ model, usage: [noSplit, noSplit] }), 2 * 164_000);
});

test('chatActual: Anthropic usage.iterations prices each attempt at its own model, without double counting', () => {
  const model = 'anthropic:claude-opus-5-5';
  const last = { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const usage = {
    input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    iterations: [{ type: 'message', model: 'claude-opus-5-5', input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, last],
  };
  // Opus 5.5 declined mid-stream: 1,000 x $4 + 500 x $20 = 14,000. Opus 4.8 answered: 1,000 x $5 + 2,000 x $25 = 55,000.
  assert.equal(chatActual({ model, usage }), 69_000);
  // A model the table doesn't know is priced at the dearest Anthropic rates (Fable: $10 / $50).
  const odd = { input_tokens: 0, output_tokens: 0, iterations: [{ type: 'message', model: 'claude-unknown-9', input_tokens: 1_000, output_tokens: 1_000 }] };
  assert.equal(chatActual({ model, usage: odd }), 60_000);
});

test('chatActual: OpenAI-style cache tokens (cached, cache writes, DeepSeek hit/miss) and long-context tiers', () => {
  // GPT-6 Astra, short context: 2,000 uncached (1,500 written at $12.50, 500 at $10), 8,000 cached at $1, 500 out at $50.
  const astra = (u) => chatActual({ model: 'openai:gpt-6-astra', usage: u });
  const u = { prompt_tokens: 10_000, prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_500 }, completion_tokens: 500, total_tokens: 10_500 };
  assert.equal(astra(u), 18_750 + 5_000 + 8_000 + 25_000);
  // Writes not reported: every fresh token is assumed written ($12.50).
  assert.equal(astra({ ...u, prompt_tokens_details: { cached_tokens: 8_000 } }), 25_000 + 8_000 + 25_000);
  // Long context (>272K input) reprices the whole request.
  assert.equal(astra({ prompt_tokens: 272_000, completion_tokens: 0 }), 272_000 * 12.5);
  assert.equal(astra({ prompt_tokens: 300_000, completion_tokens: 0 }), 300_000 * 25);
  // Reasoning missing from completion_tokens but present in total_tokens is still billed.
  assert.equal(chatActual({ model: 'meta:muse-spark-1.3', usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 2_100 } }), 1_250 + 1_100 * 4.25);
  // DeepSeek Flash (peak): 1,000 miss x $0.30 + 9,000 hit x $0.006 + 1,000 out x $1.20.
  assert.equal(chatActual({ model: 'deepseek:deepseek-flash', usage: { prompt_tokens: 10_000, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000, completion_tokens: 1_000 } }), 300 + 54 + 1_200);
  // Z.ai cached input.
  assert.equal(chatActual({ model: 'zai:glm-5.3-flash', usage: { prompt_tokens: 10_000, prompt_tokens_details: { cached_tokens: 10_000 }, completion_tokens: 0 } }), 300);
});

test('chatActual: Gemini usageMetadata, cached content and the 3.8 Flash promo date switch', () => {
  const meta = { usageMetadata: { promptTokenCount: 10_000, cachedContentTokenCount: 6_000, candidatesTokenCount: 500, thoughtsTokenCount: 1_500, totalTokenCount: 12_000 } };
  // 2027 rates: 4,000 x $1.50 + 6,000 x $0.15 + 2,000 x $7.50.
  assert.equal(chatActual({ model: 'gemini:gemini-3.8-flash', usage: meta, date: AFTER_PROMO }), 6_000 + 900 + 15_000);
  // Through 2026-12-31 the promo halves every rate.
  assert.equal(chatActual({ model: 'gemini:gemini-3.8-flash', usage: meta, date: '2026-12-31T23:59:59Z' }), 3_000 + 450 + 7_500);
  // Output is never less than total - prompt.
  const big = { promptTokenCount: 1_000, candidatesTokenCount: 10, totalTokenCount: 5_000 };
  assert.equal(chatActual({ model: 'gemini:gemini-3.5-flash-lite', usage: big }), 300 + 4_000 * 2.5);
  // 3.1 Pro bills the lower tier up to 200K prompt tokens.
  assert.equal(chatActual({ model: 'gemini:gemini-3.1-pro-preview', usage: { promptTokenCount: 200_000, candidatesTokenCount: 0 } }), 400_000);
  assert.equal(chatActual({ model: 'gemini:gemini-3.1-pro-preview', usage: { promptTokenCount: 200_001, candidatesTokenCount: 0 } }), 800_004);
  // The Gemini OpenAI-compatible route reports OpenAI-style usage.
  assert.equal(chatActual({ model: 'gemini:gemini-3.8-flash', usage: { prompt_tokens: 1_000, completion_tokens: 1_000 }, date: AFTER_PROMO }), 9_000);
});

test('worst case >= actual for the same inputs, for every paid tester chat model', () => {
  // Usage a provider would report when the call uses all of its input (none cached) and all of max_tokens.
  const usageFor = (e, prompt, out) => {
    if (e.provider === 'anthropic') return { input_tokens: 0, cache_creation_input_tokens: prompt, cache_creation: { ephemeral_5m_input_tokens: prompt, ephemeral_1h_input_tokens: 0 }, cache_read_input_tokens: 0, output_tokens: out };
    if (e.provider === 'gemini') return { usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: Math.floor(out / 2), thoughtsTokenCount: out - Math.floor(out / 2), totalTokenCount: prompt + out } };
    return { prompt_tokens: prompt, completion_tokens: out, total_tokens: prompt + out };
  };
  let checked = 0;
  for (const model of TESTER_MODELS) {
    const e = priceOf(model);
    if (e.free) continue;
    for (const inputTokens of [0, 1, 999, 50_000, 300_000]) {
      for (const maxTokens of [0, 1, 4_096]) {
        const worst = chatWorstCase({ model, inputTokens, maxTokens, margin: false });
        const out = Math.max(maxTokens, e.minOutput || 0);
        let usage = usageFor(e, inputTokens, out);
        if (e.fallbacks) {
          // Worst actual: the primary declines after its whole output, then the dearest fallback answers in full.
          const fb = e.fallbacks.map((f) => [f, chatActual({ model: f, usage: usageFor(priceOf(f), inputTokens, out) })]).sort((a, b) => b[1] - a[1])[0][0];
          usage = { ...usageFor(e, inputTokens, out), iterations: [
            { type: 'message', model: model.slice('anthropic:'.length), ...usageFor(e, inputTokens, out) },
            { type: 'fallback_message', model: fb.slice('anthropic:'.length), ...usageFor(priceOf(fb), inputTokens, out) },
          ] };
        }
        const actual = chatActual({ model, usage, date: AFTER_PROMO });
        assert.ok(worst >= actual, `${model} in=${inputTokens} max=${maxTokens}: worst ${worst} < actual ${actual}`);
        assert.ok(chatWorstCase({ model, inputTokens, maxTokens }) >= actual);
        checked++;
      }
    }
  }
  assert.equal(checked, 15 * 5 * 3); // 15 paid tester chat models (Haiku 5.5 added in v80) x 5 input sizes x 3 output caps

  // Same check with web searches (Sonnet 5.5): the turn re-reads the prompt and results after each search.
  const S = 2, P = 3_000, O = 2_000;
  const input = (S + 1) * P + WEB_SEARCH_RESULT_TOKENS * (S * (S + 1)) / 2;
  const attempt = (m) => ({ type: 'message', model: m, input_tokens: input, output_tokens: O, server_tool_use: { web_search_requests: S } });
  const usage = { input_tokens: input, output_tokens: O, server_tool_use: { web_search_requests: S }, iterations: [attempt('claude-sonnet-5-5'), { ...attempt('claude-sonnet-5'), type: 'fallback_message' }] };
  const actual = chatActual({ model: 'anthropic:claude-sonnet-5-5', usage });
  assert.ok(chatWorstCase({ model: 'anthropic:claude-sonnet-5-5', inputTokens: P, maxTokens: O, webSearches: S, margin: false }) >= actual);

  // And with Gemini video before the promo ends (the worst case uses the 2027 price).
  const vUsage = { promptTokenCount: 1_000 + 120 * 332, candidatesTokenCount: 4_096 };
  assert.ok(chatWorstCase({ model: 'gemini:gemini-3.8-flash', inputTokens: 1_000, maxTokens: 4_096, videoSeconds: 120 }) >= chatActual({ model: 'gemini:gemini-3.8-flash', usage: vUsage, date: '2026-10-01' }));
});

test('unknown models, wrong kinds and bad inputs are rejected', () => {
  for (const model of ['openai:gpt-9', 'gpt-6-astra', 'anthropic:claude-opus-5-5 ', '', undefined, 'constructor', '__proto__']) {
    throwsCode(() => chatWorstCase({ model, inputTokens: 1, maxTokens: 1 }), 'unknown_model');
    throwsCode(() => chatActual({ model, usage: { prompt_tokens: 1 } }), 'unknown_model');
    throwsCode(() => imageCost({ model, size: '1024x1024', quality: 'low' }), 'unknown_model');
    throwsCode(() => veoCost({ model, seconds: 4 }), 'unknown_model');
    throwsCode(() => maxTokensWithin({ model, inputTokens: 1 }), 'unknown_model');
  }
  assert.equal(priceOf('openai:gpt-9'), null);
  throwsCode(() => chatWorstCase({ model: 'openai:gpt-image-2.5-flare', inputTokens: 1, maxTokens: 1 }), 'wrong_kind');
  throwsCode(() => imageCost({ model: 'anthropic:claude-opus-5-5', size: '1024x1024' }), 'wrong_kind');
  throwsCode(() => veoCost({ model: 'gemini:gemini-3.8-flash', seconds: 4 }), 'wrong_kind');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', inputTokens: 1 }), 'bad_input');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', maxTokens: 1 }), 'bad_input');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', inputTokens: -1, maxTokens: 1 }), 'bad_input');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', inputTokens: Number.NaN, maxTokens: 1 }), 'bad_input');
  throwsCode(() => chatWorstCase({ model: 'zai:glm-5.3', inputTokens: '12abc', maxTokens: 1 }), 'bad_input');
  throwsCode(() => chatActual({ model: 'zai:glm-5.3' }), 'no_usage');
  throwsCode(() => chatActual({ model: 'zai:glm-5.3', usage: [] }), 'no_usage');
  throwsCode(() => imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'auto' }), 'bad_quality');
  throwsCode(() => imageCost({ model: 'openai:gpt-image-2.5-flare', size: 'auto', quality: 'medium' }), 'bad_size');
  throwsCode(() => imageCost({ model: 'openai:gpt-image-2.5-sunburst', quality: 'medium' }), 'bad_size');
  throwsCode(() => imageCost({ model: 'gemini:gemini-3-pro-image', size: '8K' }), 'bad_size');
  throwsCode(() => imageCost({ model: 'meta:muse-image-1.0', n: 0 }), 'bad_input');
  throwsCode(() => veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: 8, resolution: '8k' }), 'bad_resolution');
  throwsCode(() => veoCost({ model: 'gemini:gemini-omni-1.1-flash' }), 'bad_input');
  throwsCode(() => veoCost({ model: 'gemini:gemini-omni-1.1-flash', seconds: 0 }), 'bad_input');
  throwsCode(() => veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 4 }), 'unknown_model');
  throwsCode(() => omniActual({ model: 'nvidia/cosmos3-nano', usage: {} }), 'wrong_kind');
  throwsCode(() => omniActual({ model: 'gemini:gemini-omni-1.1-flash' }), 'no_usage');
  throwsCode(() => omniActual({ model: 'gemini:gemini-omni-1.1-flash', usage: { total_input_tokens: 10, total_output_tokens: 0 } }), 'no_usage');
});

test('free models cost $0 and are flagged', () => {
  for (const model of ['moonshotai/kimi-k3', 'zai:glm-4.7-flash', 'black-forest-labs/flux.1-dev', 'nvidia/cosmos3-nano', 'atelier/motion-still']) assert.ok(isFree(model), model);
  assert.ok(!isFree('gemini:gemini-3.8-flash'));
  assert.equal(chatWorstCase({ model: 'z-ai/glm-5.3', inputTokens: 100_000, maxTokens: 8_192 }), 0);
  assert.equal(chatActual({ model: 'zai:glm-4.7-flash', usage: { prompt_tokens: 5, completion_tokens: 5 } }), 0);
  assert.equal(imageCost({ model: 'black-forest-labs/flux.2-klein-4b', n: 4 }), 0);
  assert.equal(veoCost({ model: 'nvidia/cosmos3-nano', seconds: 5 }), 0);
  assert.equal(maxTokensWithin({ model: 'openai/gpt-oss-20b', inputTokens: 1e6, ceiling: 8_192 }), 8_192);
});

test('GPT Image 2.5 output tokens follow OpenAI\'s published calculator', () => {
  assert.equal(gptImageOutputTokens(1024, 1024, 'low'), 196);
  assert.equal(gptImageOutputTokens(1024, 1024, 'medium'), 439);
  assert.equal(gptImageOutputTokens(1024, 1024, 'high'), 1_756);
  assert.equal(gptImageOutputTokens(1024, 1024, 'max'), 7_024);
  assert.equal(gptImageOutputTokens(1024, 1280, 'high'), 1_510);
  assert.equal(gptImageOutputTokens(1792, 1008, 'medium'), 320);
  throwsCode(() => gptImageOutputTokens(1024, 1024, 'auto'), 'bad_quality');
});

test('imageCost: per-image prices, n, reference images and partial images', () => {
  // Flare 1024x1024 high, n=2: 1,000 x $5 + 2 x 1,756 x $30.
  assert.equal(imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'high', n: 2, promptTokens: 1_000, margin: false }), 5_000 + 105_360);
  // An edit reference image is reserved at 48,600 tokens x $8; partial images add 100 output tokens each.
  const plain = imageCost({ model: 'openai:gpt-image-2.5-sunburst', size: '1536x1024', quality: 'medium', promptTokens: 0, margin: false });
  assert.equal(imageCost({ model: 'openai:gpt-image-2.5-sunburst', size: '1536x1024', quality: 'medium', promptTokens: 0, inputImages: 1, margin: false }) - plain, 388_800);
  assert.equal(imageCost({ model: 'openai:gpt-image-2.5-sunburst', size: '1536x1024', quality: 'medium', promptTokens: 0, partialImages: 2, margin: false }) - plain, 6_000);
  // Nano Banana Pro 2K: 1,000 x $2 + 1,120 x $120 + 8,192 thinking x $12, per request; n=2 is two requests.
  assert.equal(imageCost({ model: 'gemini:gemini-3-pro-image', size: '2K', promptTokens: 1_000 }), 293_380);
  assert.equal(imageCost({ model: 'gemini:gemini-3-pro-image', size: '2K', promptTokens: 1_000, n: 2, margin: false }), 2 * 234_704);
  // Nano Banana 2.1 (gemini-nano-banana-2.1) at 2K is 1,680 image tokens x $30 = $0.0504; 1K $0.0336; 4K 3,780 x $30 = $0.1134.
  assert.equal(imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '2K', promptTokens: 0, thinkingTokens: 0, margin: false }), 50_400);
  assert.equal(imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '1K', promptTokens: 0, thinkingTokens: 0, margin: false }), 33_600);
  assert.equal(imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '4K', promptTokens: 0, thinkingTokens: 0, margin: false }), 113_400);
  // Its default reserve adds the 8,192-token thinking allowance at $7.50 (thinking defaults to "medium").
  assert.equal(imageCost({ model: 'gemini:gemini-nano-banana-2.1', size: '2K', promptTokens: 0, margin: false }), 50_400 + 61_440);
  // Meta: flat $0.01 per image.
  assert.equal(imageCost({ model: 'meta:muse-image-1.0', n: 4, size: '1536x864', margin: false }), 40_000);
});

test('imageActual settles from reported usage and never exceeds the matching worst case', () => {
  const oa = imageActual({ model: 'openai:gpt-image-2.5-flare', usage: { input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 439 } });
  assert.equal(oa, 100 * 5 + 439 * 30);
  assert.ok(oa <= imageCost({ model: 'openai:gpt-image-2.5-flare', size: '1024x1024', quality: 'medium', promptTokens: 100, margin: false }));
  const gem = imageActual({ model: 'gemini:gemini-3-pro-image', usage: { usageMetadata: {
    promptTokenCount: 10, candidatesTokenCount: 1_120, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1_120 }], thoughtsTokenCount: 300, totalTokenCount: 1_430,
  } } });
  assert.equal(gem, 10 * 2 + 1_120 * 120 + 300 * 12);
  assert.ok(gem <= imageCost({ model: 'gemini:gemini-3-pro-image', size: '2K', promptTokens: 10, margin: false }));
  assert.equal(imageActual({ model: 'meta:muse-image-1.0', n: 2 }), 20_000);
  throwsCode(() => imageActual({ model: 'openai:gpt-image-2.5-flare' }), 'no_usage');
});

test('veoCost (Gemini Omni): seconds x per-second reserve rate by resolution', () => {
  const OMNI = 'gemini:gemini-omni-1.1-flash', e = priceOf(OMNI);
  // 720p is Google's published rate: 5,792 video tokens a second x $17.50 per 1M = $0.10136 a second.
  assert.equal(OMNI_TOKENS_PER_SECOND['720p'], 5_792);
  for (const [res, tok] of Object.entries(OMNI_TOKENS_PER_SECOND)) assert.equal(Math.round(tok * e.videoOutput) / 1e6, e.perSecond[res], res);
  assert.deepEqual(Object.keys(e.perSecond), ['360p', '720p', '1080p', '4k']);
  assert.equal(veoCost({ model: OMNI, seconds: 6, resolution: '720p' }), 760_200); // 6 x $0.10136 x 1.25
  assert.equal(veoCost({ model: OMNI, seconds: 8, resolution: '720p' }), 1_013_600); // over the $1.00 tester cap
  assert.ok(veoCost({ model: OMNI, seconds: 8, resolution: '720p' }) > VEO_CALL_RESERVE_CAP);
  assert.equal(veoCost({ model: OMNI, seconds: 8, resolution: '1080p' }), 2_027_200);
  assert.equal(veoCost({ model: OMNI, seconds: 4, resolution: '360p', margin: false }), 405_440);
  // No resolution: the dearest one (4K, assumed 4x 720p).
  assert.equal(veoCost({ model: OMNI, seconds: 4, margin: false }), 1_621_760);
  // Partial seconds round up.
  assert.equal(veoCost({ model: OMNI, seconds: 4.2, resolution: '720p', margin: false }), 506_800);
});

test('omniActual settles a finished Omni video from the interaction usage', () => {
  const OMNI = 'gemini:gemini-omni-1.1-flash';
  const video = 6 * 5_792;
  // input $1.50, video $17.50, thinking/text $9.00 per 1M.
  const usage = { total_input_tokens: 1_000, total_output_tokens: video + 500, output_tokens_by_modality: [{ modality: 'video', tokens: video }, { modality: 'text', tokens: 500 }] };
  assert.equal(omniActual({ model: OMNI, usage }), 1_500 + 608_160 + 4_500);
  assert.equal(omniActual({ model: OMNI, usage, margin: true }), Math.ceil((1_500 + 608_160 + 4_500) * 1.25));
  // No modality breakdown: every output token at the video rate.
  assert.equal(omniActual({ model: OMNI, usage: { total_input_tokens: 1_000, total_output_tokens: video + 500 } }), 1_500 + Math.ceil((video + 500) * 17.5));
  // A 6 s 720p clip settles under its reservation (x1.25 margin covers input and thinking).
  assert.ok(omniActual({ model: OMNI, usage }) <= veoCost({ model: OMNI, seconds: 6, resolution: '720p' }));
});

test('Claude Haiku 5.5: the >100K rates for the worst case; the tier the prompt fell in for settle', () => {
  const H = 'anthropic:claude-haiku-5-5', e = priceOf(H);
  assert.deepEqual([e.input, e.output, e.cacheWrite, e.cacheWrite1h, e.cacheRead], [0.5, 2.5, 0.625, 1, 0.05]);
  assert.deepEqual({ ...e.base }, { upTo: 100_000, input: 0.1, output: 0.5, cacheWrite: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 });
  assert.equal(e.fallbacks, undefined); // no server-side refusal fallback for Haiku 5.5
  // 10,000 x $0.625 (5-minute write) + 4,000 x $2.50 = 16,250 → x1.25.
  assert.equal(chatWorstCase({ model: H, inputTokens: 10_000, maxTokens: 4_000 }), 20_313);
  assert.equal(chatActual({ model: H, usage: { input_tokens: 1_000, output_tokens: 100 } }), 150); // ≤100K: $0.10 / $0.50
  assert.equal(chatActual({ model: H, usage: { input_tokens: 200_000, output_tokens: 1_000 } }), 102_500); // >100K: $0.50 / $2.50
  // Cache reads and writes count toward the 100K: 50K fresh + 60K read = 110K → the higher tier.
  assert.equal(chatActual({ model: H, usage: { input_tokens: 50_000, cache_read_input_tokens: 60_000, output_tokens: 0 } }), 28_000);
  assert.equal(chatActual({ model: H, usage: { input_tokens: 10_000, cache_creation_input_tokens: 20_000, output_tokens: 0 } }), 1_000 + 2_500);
  assert.ok(chatWorstCase({ model: H, inputTokens: 90_000, maxTokens: 8_000, margin: false }) >= chatActual({ model: H, usage: { input_tokens: 90_000, output_tokens: 8_000 } }));
});

test('maxTokensWithin finds the per-model max_tokens cap for a $0.25 reserve', () => {
  const cases = [['anthropic:claude-sonnet-5-5', 10_000], ['anthropic:claude-opus-5-5', 4_444], ['anthropic:claude-fable-5-1', 2_666]];
  for (const [model, cap] of cases) {
    assert.equal(maxTokensWithin({ model, inputTokens: 0 }), cap, model);
    assert.ok(chatWorstCase({ model, inputTokens: 0, maxTokens: cap }) <= PER_CALL_RESERVE_CAP);
    assert.ok(chatWorstCase({ model, inputTokens: 0, maxTokens: cap + 1 }) > PER_CALL_RESERVE_CAP);
  }
  for (const model of TESTER_MODELS) {
    const m = maxTokensWithin({ model, inputTokens: 2_000, ceiling: 8_192 });
    assert.ok(m >= 0 && m <= 8_192);
    if (m > 0) assert.ok(chatWorstCase({ model, inputTokens: 2_000, maxTokens: m }) <= PER_CALL_RESERVE_CAP, model);
    if (m > 0 && m < 8_192) assert.ok(chatWorstCase({ model, inputTokens: 2_000, maxTokens: m + 1 }) > PER_CALL_RESERVE_CAP, model);
  }
  // Nothing fits: Opus 5.5 with a web search (two attempts, each with 25K result tokens and the 1024-token floor).
  assert.equal(maxTokensWithin({ model: 'anthropic:claude-opus-5-5', inputTokens: 3_000, webSearches: 1 }), 0);
  assert.equal(maxTokensWithin({ model: 'gemini:gemini-3.8-flash', inputTokens: 0, budget: 1_000_000, ceiling: 64 }), 64);
});

// ── speech (read aloud) ──
// The Atelier voice (gemini-3.8-flash-tts) and Sulafat (gemini-3.8-flash-lite-tts). OpenAI gpt-4o-mini-tts is gone (v80).
const FLASH_TTS = 'gemini:gemini-3.8-flash-tts', GEMINI_TTS = 'gemini:gemini-3.8-flash-lite-tts';

test('speech: both read-aloud models are Gemini, listed for testers with named assumptions; no OpenAI speech row is left', () => {
  assert.deepEqual([...TESTER_TTS_MODELS], [FLASH_TTS, GEMINI_TTS]);
  assert.ok(Object.isFrozen(TESTER_TTS_MODELS) && Object.isFrozen(PRICES[GEMINI_TTS].promo) && Object.isFrozen(PRICES[FLASH_TTS].promo));
  assert.equal(TTS_MIN_CHARS_PER_SECOND, 8);
  assert.equal(TTS_INSTRUCTION_TOKENS, 200);
  assert.deepEqual([PRICES[FLASH_TTS].audioTokensPerSecond, PRICES[FLASH_TTS].reserveTokensPerSecond], [25, 32]);
  assert.deepEqual([PRICES[GEMINI_TTS].audioTokensPerSecond, PRICES[GEMINI_TTS].reserveTokensPerSecond], [25, 32]);
  assert.deepEqual([PRICES[FLASH_TTS].textInput, PRICES[FLASH_TTS].audioOutput], [1, 18]);
  assert.deepEqual({ ...PRICES[FLASH_TTS].promo }, { until: '2026-12-31', textInput: 0.5, audioOutput: 9 });
  assert.deepEqual({ ...PRICES[GEMINI_TTS].promo }, { until: '2026-12-31', textInput: 0.5, audioOutput: 6 });
  assert.ok(!('openai:gpt-4o-mini-tts-2025-12-15' in PRICES));
  assert.ok(Object.values(PRICES).filter((e) => e.kind === 'tts').every((e) => e.provider === 'gemini'));
  for (const id of TESTER_TTS_MODELS) assert.ok(!(id in TESTER_EXCLUDED) && !isFree(id), id);
});

test('ttsWorstCase: integer µ$ rising with chars, at the standing price; 1,000 characters fit the per-call cap for both models', () => {
  // Flash TTS (the Atelier voice), standing price, reserved at 32 tokens/s: 125 s x 32 = 4,000 x $18 = 72,000
  // + (334 + 200) x $1 = 534 → 72,534 x 1.25 = 90,667.5 → 90,668.
  assert.equal(ttsWorstCase({ model: FLASH_TTS, chars: 1_000 }), 90_668);
  assert.equal(ttsWorstCase({ model: FLASH_TTS, chars: 1_000, margin: false }), 72_534);
  // Flash-Lite (Sulafat): 4,000 x $12 = 48,000 + 534 → 48,534 x 1.25 = 60,667.5 → 60,668.
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 1_000 }), 60_668);
  for (const model of TESTER_TTS_MODELS) {
    assert.ok(ttsWorstCase({ model, chars: 1_000 }) <= PER_CALL_RESERVE_CAP, model);
    let prev = -1;
    for (const chars of [0, 1, 8, 9, 100, 500, 1_000, 4_000]) {
      const v = ttsWorstCase({ model, chars });
      assert.ok(Number.isInteger(v) && v >= prev, `${model} ${chars}`);
      prev = v;
    }
    assert.ok(ttsWorstCase({ model, chars: 9 }) > ttsWorstCase({ model, chars: 8 }), 'a started second is a whole second');
  }
});

test('ttsWorstCase: priced on spoken units (numbers, CJK) when given; the Gemini output bound is a true ceiling', () => {
  // 250 digits are 1,000 spoken units: the same reservation as 1,000 letters, four times that of 250 letters' worth.
  assert.equal(ttsWorstCase({ model: FLASH_TTS, chars: 250, units: 1_000 }), 90_668);
  assert.ok(ttsWorstCase({ model: FLASH_TTS, chars: 250, units: 1_000 }) > 3 * ttsWorstCase({ model: FLASH_TTS, chars: 250 }));
  assert.equal(ttsWorstCase({ model: FLASH_TTS, chars: 1_000, units: 10 }), 90_668, 'units never count below chars');
  // 12,000 units: 1,500 s x 32 = 48,000 tokens, bounded at 4,369. Flash: 4,369 x $18 = 78,642 + 4,200 → 82,842 x 1.25.
  assert.equal(ttsWorstCase({ model: FLASH_TTS, chars: 4_000, units: 12_000, maxAudioTokens: 4_369 }), 103_553);
  // Flash-Lite: 4,369 x $12 = 52,428 + 4,200 → 56,628 x 1.25.
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 4_000, units: 12_000, maxAudioTokens: 4_369 }), 70_785);
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 1_000, maxAudioTokens: 4_369 }), 60_668, 'a bound above the estimate changes nothing');
  for (const model of TESTER_TTS_MODELS) {
    const atBound = ttsActual({ model, usage: { promptTokenCount: 4_200 }, seconds: 4_369 / 25, date: AFTER_PROMO });
    assert.ok(ttsWorstCase({ model, chars: 4_000, units: 12_000, maxAudioTokens: 4_369, margin: false }) >= atBound, model);
  }
  throwsCode(() => ttsWorstCase({ model: GEMINI_TTS, chars: 10, maxAudioTokens: -1 }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: FLASH_TTS, chars: 10, units: 'lots' }), 'bad_input');
});

test('ttsReserved: the audio a reservation pays for (the tester maxOutputTokens), the same for both models', () => {
  for (const model of TESTER_TTS_MODELS) {
    assert.deepEqual(ttsReserved({ model, chars: 12 }), { units: 12, seconds: 2, audioTokens: 64 }, model);
    assert.deepEqual(ttsReserved({ model, chars: 250, units: 1_000 }), { units: 1_000, seconds: 125, audioTokens: 4_000 }, model);
    assert.deepEqual(ttsReserved({ model, chars: 4_000, units: 12_000, maxAudioTokens: 4_369 }), { units: 12_000, seconds: 1_500, audioTokens: 4_369 }, model);
  }
});

test('ttsActual: Gemini bills max(the reported audio tokens, seconds x 25), promo through 2026-12-31, standing price after', () => {
  const usage = { promptTokenCount: 300 };
  // Flash-Lite promo: 300 x $0.50 + 85 x 25 = 2,125 x $6 → 150 + 12,750
  assert.equal(ttsActual({ model: GEMINI_TTS, usage, seconds: 85, date: '2026-12-31T23:59:59Z' }), 12_900);
  // standing: 300 x $1 + 2,125 x $12
  assert.equal(ttsActual({ model: GEMINI_TTS, usage, seconds: 85, date: '2027-01-01T00:00:00Z' }), 25_800);
  // a reported count above seconds x 25 is billed; fractional seconds round up per token, not per second
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 0, candidatesTokenCount: 3_000 }, seconds: 85, date: AFTER_PROMO }), 36_000);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 0 }, seconds: 1.2, date: AFTER_PROMO }), 30 * 12);
  // no usageMetadata: input is estimated from the characters sent (ceil(300 / 3) + 200)
  assert.equal(ttsActual({ model: GEMINI_TTS, seconds: 10, chars: 300, date: AFTER_PROMO }), 300 + 250 * 12);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { usageMetadata: usage }, seconds: 85, date: AFTER_PROMO }), 25_800, 'a response holding usageMetadata');
  for (const model of TESTER_TTS_MODELS) {
    throwsCode(() => ttsActual({ model }), 'no_usage');
    throwsCode(() => ttsActual({ model, usage: null }), 'no_usage');
    throwsCode(() => ttsActual({ model, usage, seconds: -1 }), 'bad_input');
    throwsCode(() => ttsActual({ model, usage, seconds: true }), 'bad_input');
    for (const seconds of ['x', Infinity]) throwsCode(() => ttsActual({ model, seconds }), 'bad_input');
  }
});

test('ttsActual: the Atelier voice (Flash TTS) at $0.50 / $9.00 through 2026-12-31, then $1.00 / $18.00', () => {
  const usage = { promptTokenCount: 300 };
  // promo: 300 x $0.50 + 2,125 x $9 = 150 + 19,125
  assert.equal(ttsActual({ model: FLASH_TTS, usage, seconds: 85, date: '2026-10-07T12:00:00Z' }), 19_275);
  assert.equal(ttsActual({ model: FLASH_TTS, usage, seconds: 85, date: '2026-12-31T23:59:59Z' }), 19_275);
  // standing from 2027-01-01 (UTC): 300 x $1 + 2,125 x $18
  assert.equal(ttsActual({ model: FLASH_TTS, usage, seconds: 85, date: '2027-01-01T00:00:00Z' }), 38_550);
  // a live-style answer reporting ≈ 32 tokens/s: the reported count is billed, not seconds x 25
  const live = { promptTokenCount: 36, candidatesTokenCount: 388, totalTokenCount: 424 };
  assert.equal(ttsActual({ model: FLASH_TTS, usage: live, seconds: 12.2, date: AFTER_PROMO }), 36 + 388 * 18);
  assert.equal(ttsActual({ model: FLASH_TTS, usage: live, seconds: 12.2, date: '2026-11-01' }), 18 + 388 * 9);
  // the seconds floor is held to the request's maxOutputTokens; the reported count never is
  assert.equal(ttsActual({ model: FLASH_TTS, usage: { promptTokenCount: 36 }, seconds: 12.2, maxAudioTokens: 200, date: AFTER_PROMO }), 36 + 200 * 18);
  assert.equal(ttsActual({ model: FLASH_TTS, usage: live, seconds: 12.2, maxAudioTokens: 200, date: AFTER_PROMO }), 36 + 388 * 18);
  assert.equal(ttsActual({ model: FLASH_TTS, usage, seconds: 85, margin: true, date: AFTER_PROMO }), Math.ceil(38_550 * 1.25));
});

test('ttsActual: Gemini runs above the published 25 tokens/s (a live Sulafat read: 388 for 12.2 s), so the reported count is billed', () => {
  const live = { promptTokenCount: 36, candidatesTokenCount: 388, totalTokenCount: 424 }; // the owner's log, 2026-10-01
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: live, seconds: 12.2, date: AFTER_PROMO }), 36 * 1 + 388 * 12);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: live, seconds: 12.2, date: '2026-10-01T12:00:00Z' }), 18 + 388 * 6);
  // seconds x 25 alone would bill 305 audio tokens: about 27% under what Google reported
  const bySeconds = ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 36 }, seconds: 12.2, date: AFTER_PROMO });
  assert.equal(bySeconds, 36 + 305 * 12);
  assert.ok(ttsActual({ model: GEMINI_TTS, usage: live, seconds: 12.2, date: AFTER_PROMO }) / bySeconds > 1.25);
  // totalTokenCount - promptTokenCount counts too, when candidatesTokenCount is missing
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 36, totalTokenCount: 424 }, seconds: 12.2, date: AFTER_PROMO }), 36 + 388 * 12);
  // maxAudioTokens (the request's own maxOutputTokens) holds the seconds floor to it, never the reported count.
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 36 }, seconds: 12.2, maxAudioTokens: 200, date: AFTER_PROMO }), 36 + 200 * 12);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: live, seconds: 12.2, maxAudioTokens: 200, date: AFTER_PROMO }), 36 + 388 * 12);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 36 }, seconds: 12.2, maxAudioTokens: 10_000, date: AFTER_PROMO }), bySeconds);
  assert.equal(ttsActual({ model: GEMINI_TTS, seconds: 12.2, chars: 300, maxAudioTokens: 200, date: AFTER_PROMO }), 300 + 200 * 12, 'no usageMetadata');
  for (const maxAudioTokens of [-1, 'x', true]) throwsCode(() => ttsActual({ model: GEMINI_TTS, usage: live, seconds: 1, maxAudioTokens }), 'bad_input');
});

test('speech: worst case >= actual at the assumed slowest pace and token rate, for any date, for both models; even when read slower', () => {
  for (const model of TESTER_TTS_MODELS) {
    for (const chars of [1, 50, 220, 999, 1_000]) {
      const seconds = Math.ceil(chars / TTS_MIN_CHARS_PER_SECOND);
      for (const date of ['2026-10-01', AFTER_PROMO]) {
        const g = ttsActual({ model, usage: { promptTokenCount: Math.ceil(chars / 3) + TTS_INSTRUCTION_TOKENS }, seconds, date });
        assert.ok(ttsWorstCase({ model, chars, margin: false }) >= g, `${model} ${chars} ${date}`);
        // held to the reserved tokens (maxOutputTokens) but reading at under 25 tokens a second (3x the seconds):
        // the reported count is at most the bound, and so is the seconds floor once the bound is passed in.
        const held = ttsReserved({ model, chars });
        const slow = ttsActual({ model, usage: { promptTokenCount: Math.ceil(chars / 3) + TTS_INSTRUCTION_TOKENS, candidatesTokenCount: held.audioTokens }, seconds: 3 * seconds, maxAudioTokens: held.audioTokens, date });
        assert.ok(ttsWorstCase({ model, chars, margin: false }) >= slow, `${model} slow ${chars} ${date}`);
      }
    }
  }
});

test('speech: unknown models (the retired OpenAI ones among them), wrong kinds and bad inputs are rejected', () => {
  for (const model of ['openai:gpt-4o-mini-tts-2025-12-15', 'openai:gpt-4o-mini-tts', 'openai:tts-1', 'gpt-4o-mini-tts-2025-12-15', 'gemini-3.8-flash-tts', '', undefined, '__proto__']) {
    throwsCode(() => ttsWorstCase({ model, chars: 10 }), 'unknown_model');
    throwsCode(() => ttsActual({ model, usage: { promptTokenCount: 1, candidatesTokenCount: 1 } }), 'unknown_model');
  }
  throwsCode(() => ttsWorstCase({ model: 'openai:gpt-6-luna', chars: 10 }), 'wrong_kind');
  throwsCode(() => chatWorstCase({ model: FLASH_TTS, inputTokens: 1, maxTokens: 1 }), 'wrong_kind');
  throwsCode(() => ttsWorstCase({ model: FLASH_TTS }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: FLASH_TTS, chars: -1 }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: FLASH_TTS, chars: 'many' }), 'bad_input');
});

// ── dictation (speech to text) ──
const OPENAI_STT = 'openai:gpt-transcribe', GEMINI_STT = 'gemini:gemini-3.5-flash-lite#stt';

test('dictation: OpenAI gpt-transcribe (duration-billed) and the Gemini fallback are listed for testers; the chat row keeps its id', () => {
  assert.deepEqual([...TESTER_STT_MODELS], [OPENAI_STT, GEMINI_STT]);
  assert.ok(Object.isFrozen(TESTER_STT_MODELS) && Object.isFrozen(PRICES[OPENAI_STT]));
  assert.equal(PRICES['gemini:gemini-3.5-flash-lite'].kind, 'chat');
  assert.ok(!TESTER_MODELS.includes(GEMINI_STT) && !TESTER_STT_MODELS.includes('gemini:gemini-3.5-flash-lite'));
  assert.deepEqual([PRICES[OPENAI_STT].perMinute, PRICES[GEMINI_STT].audioTokensPerSecond], [0.0045, 32]);
  assert.equal(STT_MIN_BYTES_PER_SECOND, 1_000);
  assert.ok(!('openai:gpt-4o-mini-transcribe-2025-12-15' in PRICES));
  for (const id of TESTER_STT_MODELS) assert.ok(!(id in TESTER_EXCLUDED) && !isFree(id), id);
});

test('sttWorstCase: OpenAI is the recording’s ceiling seconds (the WAV’s, else its bytes at 1,000 a second) at $0.0045 a minute; Gemini its counted input plus its output bound', () => {
  // $0.0045 a minute is 75 µ$ a second. A 2.26 s WAV is reserved as 3 s: 225 x 1.25 = 281.25 → 282.
  assert.equal(sttWorstCase({ model: OPENAI_STT, seconds: 2.26, bytes: 72_000 }), 282);
  assert.equal(sttWorstCase({ model: OPENAI_STT, seconds: 2.26, bytes: 72_000, margin: false }), 225);
  assert.equal(sttWorstCase({ model: OPENAI_STT, seconds: 180, bytes: 5_760_044 }), Math.ceil(180 * 75 * 1.25), 'a WAV is its own length, whatever its size');
  // a length the header doesn't give: the bytes at STT_MIN_BYTES_PER_SECOND (8 kbit/s), rounded up
  assert.equal(sttWorstCase({ model: OPENAI_STT, seconds: null, bytes: 2_000 }), 188);
  assert.equal(sttWorstCase({ model: OPENAI_STT, bytes: 2_001 }), Math.ceil(3 * 75 * 1.25));
  assert.equal(sttWorstCase({ model: OPENAI_STT, bytes: 0 }), 94, 'at least one second');
  // 120 s recorded at 64 kbit/s (983,040 bytes): reserved as 984 s, $0.074 x 1.25
  assert.equal(sttWorstCase({ model: OPENAI_STT, bytes: 983_040 }), Math.ceil(984 * 75 * 1.25));
  // the $0.25 call cap: 2,666 s of bytes fit, 2,667 don't; the 10 MB upload cap is far past it
  assert.ok(sttWorstCase({ model: OPENAI_STT, bytes: 2_666_000 }) <= PER_CALL_RESERVE_CAP);
  assert.ok(sttWorstCase({ model: OPENAI_STT, bytes: 2_667_000 }) > PER_CALL_RESERVE_CAP);
  assert.ok(sttWorstCase({ model: OPENAI_STT, bytes: 10 * 1024 * 1024 }) > PER_CALL_RESERVE_CAP);
  assert.deepEqual([sttCeilingSeconds({ seconds: 0.2 }), sttCeilingSeconds({ seconds: 3 }), sttCeilingSeconds({ bytes: 1 }), sttCeilingSeconds({ seconds: null, bytes: 5_500 })], [1, 3, 1, 6]);
  throwsCode(() => sttWorstCase({ model: OPENAI_STT }), 'bad_input');
  throwsCode(() => sttWorstCase({ model: OPENAI_STT, bytes: -1 }), 'bad_input');
  throwsCode(() => sttWorstCase({ model: OPENAI_STT, seconds: 'long' }), 'bad_input');
  // 180 s of audio (5,760 tokens) plus 1,024 for the instructions, 4,096 output: (6,784 x 0.3 + 4,096 x 2.5) x 1.25
  assert.equal(sttWorstCase({ model: GEMINI_STT, inputTokens: 6_784, maxOutputTokens: 4_096 }), 15_344);
  assert.equal(sttWorstCase({ model: GEMINI_STT, inputTokens: 6_784, maxOutputTokens: 4_096, margin: false }), 12_276);
  throwsCode(() => sttWorstCase({ model: GEMINI_STT, maxOutputTokens: 4_096 }), 'bad_input');
  throwsCode(() => sttWorstCase({ model: GEMINI_STT, inputTokens: 100 }), 'bad_input');
  throwsCode(() => sttWorstCase({ model: GEMINI_STT, inputTokens: -1, maxOutputTokens: 1 }), 'bad_input');
  throwsCode(() => sttWorstCase({ model: 'gemini:gemini-3.5-flash-lite', inputTokens: 1, maxOutputTokens: 1 }), 'wrong_kind');
  throwsCode(() => sttWorstCase({ model: 'openai:whisper-1' }), 'unknown_model');
  throwsCode(() => sttWorstCase({ model: 'openai:gpt-4o-mini-transcribe-2025-12-15', bytes: 1 }), 'unknown_model');
});

test('sttActual: OpenAI from the billed duration (else the WAV’s seconds); Gemini from the reported tokens; else no_usage', () => {
  // usage {type: "duration", seconds}: 12 s x 75 µ$; a part second is a whole one
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 12 } }), 900);
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 12.2 } }), 975);
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 12 }, margin: true }), 1_125);
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 0 } }), 0);
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 12 }, seconds: 30 }), 900, 'the billed duration wins over the WAV’s length');
  // a token usage (the reference documents both shapes) or none: the WAV's measured seconds
  assert.equal(sttActual({ model: OPENAI_STT, usage: { type: 'tokens', input_tokens: 120, output_tokens: 8 }, seconds: 3.2 }), 300);
  assert.equal(sttActual({ model: OPENAI_STT, usage: null, seconds: 2 }), 150);
  // the settle never passes the reservation for the same length
  assert.ok(sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: 2.26 } }) <= sttWorstCase({ model: OPENAI_STT, seconds: 2.26, bytes: 1, margin: false }));
  throwsCode(() => sttActual({ model: OPENAI_STT }), 'no_usage');
  throwsCode(() => sttActual({ model: OPENAI_STT, usage: { type: 'tokens', input_tokens: 120, output_tokens: 8 } }), 'no_usage');
  throwsCode(() => sttActual({ model: OPENAI_STT, usage: { type: 'duration', seconds: -1 } }), 'no_usage');
  assert.equal(sttActual({ model: GEMINI_STT, usage: { promptTokenCount: 230, candidatesTokenCount: 9, thoughtsTokenCount: 40, totalTokenCount: 279 } }), 192);
  assert.equal(sttActual({ model: GEMINI_STT, usage: { usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 100 } } }), 550);
  throwsCode(() => sttActual({ model: GEMINI_STT, usage: { candidatesTokenCount: 5 } }), 'no_usage');
  throwsCode(() => sttActual({ model: GEMINI_STT }), 'no_usage');
});
