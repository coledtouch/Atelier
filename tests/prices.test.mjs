import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES_CHECKED, MARGIN, PRICES, PER_CALL_RESERVE_CAP, WEB_SEARCH_RESULT_TOKENS, GEMINI_VIDEO_TOKENS_PER_SECOND,
  TESTER_MODELS, TESTER_IMAGE_MODELS, TESTER_VIDEO_MODELS, TESTER_EXCLUDED, WEB_CALL_RESERVE_CAP, VEO_CALL_RESERVE_CAP,
  chatWorstCase, chatActual, imageCost, imageActual, veoCost, maxTokensWithin, gptImageOutputTokens,
  priceOf, isFree, PriceError,
  TESTER_TTS_MODELS, ttsWorstCase, ttsReserved, ttsActual, OPENAI_TTS_AUDIO_TOKENS_PER_SECOND, TTS_MIN_CHARS_PER_SECOND, TTS_INSTRUCTION_TOKENS, TTS_CUTOFF_FACTOR,
} from '../src/tester/prices.js';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof PriceError && e.code === code, `expected PriceError ${code}`);
const AFTER_PROMO = '2027-01-02T12:00:00Z';

test('header constants: checked date, margin, per-call caps', () => {
  assert.equal(PRICES_CHECKED, '2026-09-30');
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
  for (const [list, kind] of [[TESTER_MODELS, 'chat'], [TESTER_IMAGE_MODELS, 'image'], [TESTER_VIDEO_MODELS, 'video'], [TESTER_TTS_MODELS, 'tts']]) {
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
      if (kind === 'image' && !e.free) {
        const size = e.provider === 'gemini' ? '2K' : e.sizes[0];
        assert.ok(imageCost({ model: id, size, quality: e.qualities ? 'medium' : undefined }) > 0);
      }
    }
  }
});

test('the app\'s paid models are listed for testers; fallback-only targets and Veo standard are not', () => {
  for (const id of ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-fable-5-1', 'openai:gpt-6-luna',
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
  assert.ok(!TESTER_VIDEO_MODELS.includes('gemini:veo-3.1-generate-preview'));
  assert.match(TESTER_EXCLUDED['gemini:veo-3.1-generate-preview'], /\$2\.00/);
  assert.ok(TESTER_VIDEO_MODELS.includes('gemini:veo-3.1-lite-generate-preview'));
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
  for (const v of [chatWorstCase({ model: 'deepseek:deepseek-flash', inputTokens: 7, maxTokens: 3 }), veoCost({ model: 'gemini:veo-3.1-fast-generate-preview', seconds: 4 })]) {
    assert.ok(Number.isInteger(v));
  }
});

test('reserve functions apply the 1.25 margin; settle functions do not unless asked', () => {
  assert.equal(imageCost({ model: 'meta:muse-image-1.0' }), 12_500);
  assert.equal(imageCost({ model: 'meta:muse-image-1.0', margin: false }), 10_000);
  assert.equal(veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 4, resolution: '720p' }), 250_000);
  assert.equal(veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 4, resolution: '720p', margin: false }), 200_000);
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
  assert.equal(checked, 14 * 5 * 3); // 14 paid tester chat models x 5 input sizes x 3 output caps

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
  throwsCode(() => veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 8, resolution: '4k' }), 'bad_resolution');
  throwsCode(() => veoCost({ model: 'gemini:veo-3.1-lite-generate-preview' }), 'bad_input');
  throwsCode(() => veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 0 }), 'bad_input');
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
  // Nano Banana 2 at 2K is 1,680 image tokens x $60 = $0.1008.
  assert.equal(imageCost({ model: 'gemini:gemini-3.1-flash-image', size: '2K', promptTokens: 0, thinkingTokens: 0, margin: false }), 100_800);
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

test('veoCost: seconds x per-second price by resolution', () => {
  assert.equal(veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 8, resolution: '1080p' }), 800_000);
  assert.equal(veoCost({ model: 'gemini:veo-3.1-fast-generate-preview', seconds: 8, resolution: '1080p' }), 1_200_000);
  assert.equal(veoCost({ model: 'gemini:veo-3.1-fast-generate-preview', seconds: 4, resolution: '720p' }), 500_000);
  // No resolution: the dearest one (Fast 4K, $0.30/s).
  assert.equal(veoCost({ model: 'gemini:veo-3.1-fast-generate-preview', seconds: 4, margin: false }), 1_200_000);
  assert.equal(veoCost({ model: 'gemini:veo-3.1-generate-preview', seconds: 4, resolution: '720p' }), 2_000_000);
  // Partial seconds round up.
  assert.equal(veoCost({ model: 'gemini:veo-3.1-lite-generate-preview', seconds: 4.2, resolution: '720p', margin: false }), 250_000);
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
const OPENAI_TTS = 'openai:gpt-4o-mini-tts-2025-12-15', GEMINI_TTS = 'gemini:gemini-3.8-flash-lite-tts';

test('speech: both read-aloud models are listed for testers with named assumptions', () => {
  assert.deepEqual([...TESTER_TTS_MODELS], [OPENAI_TTS, GEMINI_TTS]);
  assert.ok(Object.isFrozen(TESTER_TTS_MODELS) && Object.isFrozen(PRICES[GEMINI_TTS].promo));
  assert.equal(OPENAI_TTS_AUDIO_TOKENS_PER_SECOND, 50);
  assert.equal(TTS_MIN_CHARS_PER_SECOND, 8);
  assert.equal(TTS_INSTRUCTION_TOKENS, 200);
  assert.equal(PRICES[OPENAI_TTS].audioTokensPerSecond, OPENAI_TTS_AUDIO_TOKENS_PER_SECOND);
  assert.equal(PRICES[GEMINI_TTS].audioTokensPerSecond, 25);
  assert.deepEqual({ ...PRICES[GEMINI_TTS].promo }, { until: '2026-12-31', textInput: 0.5, audioOutput: 6 });
  for (const id of TESTER_TTS_MODELS) assert.ok(!(id in TESTER_EXCLUDED) && !isFree(id), id);
});

test('ttsWorstCase: integer µ$ rising with chars; 1,000 characters fit the per-call cap for both models', () => {
  // OpenAI, 1,000 chars: 125 s x 50 tok/s x $12 = 75,000 + (334 + 200) x $0.60 = 320.4 → 75,320.4 x 1.25 → 94,151.
  assert.equal(ttsWorstCase({ model: OPENAI_TTS, chars: 1_000 }), 94_151);
  assert.equal(ttsWorstCase({ model: OPENAI_TTS, chars: 1_000, margin: false }), 75_321);
  // Gemini at the standing price: 125 s x 25 x $12 = 37,500 + 534 x $1 → 38,034 x 1.25 → 47,543.
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 1_000 }), 47_543);
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

test('ttsWorstCase: priced on spoken units (numbers, CJK) when given; a Gemini output bound is a true ceiling', () => {
  // 250 digits are 1,000 spoken units: the same reservation as 1,000 letters, four times that of 250 letters' worth.
  assert.equal(ttsWorstCase({ model: OPENAI_TTS, chars: 250, units: 1_000 }), 94_151);
  assert.ok(ttsWorstCase({ model: OPENAI_TTS, chars: 250, units: 1_000 }) > 3 * ttsWorstCase({ model: OPENAI_TTS, chars: 250 }));
  assert.equal(ttsWorstCase({ model: OPENAI_TTS, chars: 1_000, units: 10 }), 94_151, 'units never count below chars');
  // Gemini, 12,000 units: 1,500 s x 25 = 37,500 tokens, bounded at 4,369 x $12 = 52,428 + (4,000 + 200) x $1 → 56,628 x 1.25.
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 4_000, units: 12_000, maxAudioTokens: 4_369 }), 70_785);
  assert.equal(ttsWorstCase({ model: GEMINI_TTS, chars: 1_000, maxAudioTokens: 4_369 }), 47_543, 'a bound above the estimate changes nothing');
  const atBound = ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 4_200 }, seconds: 4_369 / 25, date: AFTER_PROMO });
  assert.ok(ttsWorstCase({ model: GEMINI_TTS, chars: 4_000, units: 12_000, maxAudioTokens: 4_369, margin: false }) >= atBound);
  throwsCode(() => ttsWorstCase({ model: GEMINI_TTS, chars: 10, maxAudioTokens: -1 }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: OPENAI_TTS, chars: 10, units: 'lots' }), 'bad_input');
});

test('ttsReserved: the audio a reservation pays for, and the cut-off that holds OpenAI to it', () => {
  assert.equal(TTS_CUTOFF_FACTOR, 2);
  assert.deepEqual(ttsReserved({ model: OPENAI_TTS, chars: 12 }), { units: 12, seconds: 2, audioTokens: 100, cutoffSeconds: 5 });
  assert.deepEqual(ttsReserved({ model: OPENAI_TTS, chars: 250, units: 1_000 }), { units: 1_000, seconds: 125, audioTokens: 6_250, cutoffSeconds: 251 });
  assert.deepEqual(ttsReserved({ model: GEMINI_TTS, chars: 4_000, units: 12_000, maxAudioTokens: 4_369 }), { units: 12_000, seconds: 1_500, audioTokens: 4_369, cutoffSeconds: 3_001 });
  // Cut off at cutoffSeconds, OpenAI's published rate (≈21 audio tokens a second) stays inside the reservation.
  for (const chars of [1, 8, 12, 100, 1_000]) {
    const held = ttsReserved({ model: OPENAI_TTS, chars });
    const atCut = ttsActual({ model: OPENAI_TTS, usage: { input_tokens: Math.ceil(chars / 3) + 200, output_tokens: Math.ceil(held.cutoffSeconds * 21) } });
    assert.ok(atCut <= ttsWorstCase({ model: OPENAI_TTS, chars }), `${chars} chars: ${atCut}`);
  }
});

test('ttsActual: OpenAI from speech.audio.done usage; missing or zero audio tokens throw no_usage', () => {
  // 300 x $0.60 + 1,800 x $12 = 180 + 21,600.
  assert.equal(ttsActual({ model: OPENAI_TTS, usage: { input_tokens: 300, output_tokens: 1_800, total_tokens: 2_100 } }), 21_780);
  assert.equal(ttsActual({ model: OPENAI_TTS, usage: { input_tokens: 300, output_tokens: 1_800 }, margin: true }), 27_225);
  // output is never less than total - input
  assert.equal(ttsActual({ model: OPENAI_TTS, usage: { input_tokens: 100, output_tokens: 500, total_tokens: 900 } }), 60 + 800 * 12);
  throwsCode(() => ttsActual({ model: OPENAI_TTS }), 'no_usage');
  throwsCode(() => ttsActual({ model: OPENAI_TTS, usage: null }), 'no_usage');
  throwsCode(() => ttsActual({ model: OPENAI_TTS, usage: { input_tokens: 40, output_tokens: 0, total_tokens: 40 } }), 'no_usage');
  throwsCode(() => ttsActual({ model: OPENAI_TTS, seconds: 30 }), 'no_usage');
});

test('ttsActual: Gemini from the seconds of audio (25 tokens/s), promo through 2026-12-31, standing price after', () => {
  const usage = { promptTokenCount: 300 };
  // promo: 300 x $0.50 + 85 x 25 = 2,125 x $6 → 150 + 12,750
  assert.equal(ttsActual({ model: GEMINI_TTS, usage, seconds: 85, date: '2026-12-31T23:59:59Z' }), 12_900);
  // standing: 300 x $1 + 2,125 x $12
  assert.equal(ttsActual({ model: GEMINI_TTS, usage, seconds: 85, date: '2027-01-01T00:00:00Z' }), 25_800);
  // a reported count above seconds x 25 is billed; fractional seconds round up per token, not per second
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 0, candidatesTokenCount: 3_000 }, seconds: 85, date: AFTER_PROMO }), 36_000);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: 0 }, seconds: 1.2, date: AFTER_PROMO }), 30 * 12);
  // no usageMetadata: input is estimated from the characters sent (ceil(300 / 3) + 200)
  assert.equal(ttsActual({ model: GEMINI_TTS, seconds: 10, chars: 300, date: AFTER_PROMO }), 300 + 250 * 12);
  assert.equal(ttsActual({ model: GEMINI_TTS, usage: { usageMetadata: usage }, seconds: 85, date: AFTER_PROMO }), 25_800, 'a response holding usageMetadata');
  throwsCode(() => ttsActual({ model: GEMINI_TTS }), 'no_usage');
  throwsCode(() => ttsActual({ model: GEMINI_TTS, usage, seconds: -1 }), 'bad_input');
  throwsCode(() => ttsActual({ model: GEMINI_TTS, usage, seconds: true }), 'bad_input');
});

test('speech: worst case >= actual at the assumed slowest pace and token rate, for any date', () => {
  for (const chars of [1, 50, 220, 999, 1_000]) {
    const seconds = Math.ceil(chars / TTS_MIN_CHARS_PER_SECOND);
    const openai = { input_tokens: Math.ceil(chars / 3) + TTS_INSTRUCTION_TOKENS, output_tokens: seconds * OPENAI_TTS_AUDIO_TOKENS_PER_SECOND };
    assert.ok(ttsWorstCase({ model: OPENAI_TTS, chars, margin: false }) >= ttsActual({ model: OPENAI_TTS, usage: openai }), `openai ${chars}`);
    for (const date of ['2026-10-01', AFTER_PROMO]) {
      const g = ttsActual({ model: GEMINI_TTS, usage: { promptTokenCount: Math.ceil(chars / 3) + TTS_INSTRUCTION_TOKENS }, seconds, date });
      assert.ok(ttsWorstCase({ model: GEMINI_TTS, chars, margin: false }) >= g, `gemini ${chars} ${date}`);
    }
  }
});

test('speech: unknown models, wrong kinds and bad inputs are rejected', () => {
  for (const model of ['openai:gpt-4o-mini-tts', 'openai:tts-1', 'gpt-4o-mini-tts-2025-12-15', '', undefined, '__proto__']) {
    throwsCode(() => ttsWorstCase({ model, chars: 10 }), 'unknown_model');
    throwsCode(() => ttsActual({ model, usage: { input_tokens: 1, output_tokens: 1 } }), 'unknown_model');
  }
  throwsCode(() => ttsWorstCase({ model: 'openai:gpt-6-luna', chars: 10 }), 'wrong_kind');
  throwsCode(() => chatWorstCase({ model: OPENAI_TTS, inputTokens: 1, maxTokens: 1 }), 'wrong_kind');
  throwsCode(() => ttsWorstCase({ model: OPENAI_TTS }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: OPENAI_TTS, chars: -1 }), 'bad_input');
  throwsCode(() => ttsWorstCase({ model: OPENAI_TTS, chars: 'many' }), 'bad_input');
});
