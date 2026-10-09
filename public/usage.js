// What a chat request cost in tokens, as each provider reports it, and the owner's cache readout ("cached 92%" on an
// answer's meta line). Pure — no DOM, no app state — so app.js and tests/prompt-cache.test.mjs both import it.
//
// The Worker passes every provider's own usage through (src/worker.js asks the OpenAI-style providers for it with
// stream_options.include_usage; src/anthropic.js sends Claude's; src/gemini.js Gemini's native usageMetadata), and
// readUsage reads the shapes:
//   Anthropic   input_tokens (the uncached rest only), cache_read_input_tokens, cache_creation_input_tokens, output_tokens
//   OpenAI      prompt_tokens (all of it), prompt_tokens_details.cached_tokens [, .cache_write_tokens], completion_tokens
//               — xAI, Z.ai and Meta report the same; Gemini's OpenAI route may leave the cached count out
//   DeepSeek    prompt_tokens, prompt_cache_hit_tokens / prompt_cache_miss_tokens, completion_tokens
//   Gemini      usageMetadata: promptTokenCount (cached included), cachedContentTokenCount, candidatesTokenCount,
//               thoughtsTokenCount (src/gemini.js, the native video route)

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
const has = (v) => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// One request's usage → { input, cached, written, output } (null when there is nothing to read):
//   input    every prompt token, the cached and written ones included
//   cached   prompt tokens read from the provider's cache (null: the provider didn't say)
//   written  prompt tokens written to it (Claude; OpenAI's newer models), null when not reported
//   output   output tokens, thinking included
export function readUsage(u) {
  u = rec(u);
  if (!u) return null;
  if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
    const cached = num(u.cache_read_input_tokens), written = num(u.cache_creation_input_tokens);
    return { input: num(u.input_tokens) + cached + written, cached, written, output: num(u.output_tokens) };
  }
  if ('promptTokenCount' in u || 'candidatesTokenCount' in u) {
    const input = num(u.promptTokenCount) + num(u.toolUsePromptTokenCount);
    let output = num(u.candidatesTokenCount) + num(u.thoughtsTokenCount);
    if (num(u.totalTokenCount)) output = Math.max(output, num(u.totalTokenCount) - input);
    return { input, cached: Math.min(num(u.cachedContentTokenCount), input), written: null, output };
  }
  if (!('prompt_tokens' in u) && !('input_tokens' in u) && !('completion_tokens' in u)) return null;
  const d = rec(u.prompt_tokens_details) || rec(u.input_tokens_details) || {};
  const input = num(u.prompt_tokens ?? u.input_tokens);
  const hit = has(d.cached_tokens) ? d.cached_tokens : has(u.prompt_cache_hit_tokens) ? u.prompt_cache_hit_tokens : null;
  const wrote = [d.cache_write_tokens, d.cache_creation_tokens, d.cache_creation_input_tokens].find(has);
  const od = rec(u.completion_tokens_details) || rec(u.output_tokens_details) || {};
  // Some providers leave reasoning out of completion_tokens but count it in total_tokens (src/tester/prices.js).
  const output = Math.max(num(u.completion_tokens ?? u.output_tokens), num(od.reasoning_tokens), num(u.total_tokens) ? num(u.total_tokens) - input : 0);
  return { input, cached: hit == null ? null : Math.min(num(hit), input), written: wrote == null ? null : num(wrote), output };
}

// The usage of every request one answer made (an agent's tool rounds, a nudge, a model fallback), added up. Either side
// may be missing or come from storage (synced or restored entries are only shape-checked).
export function addUsage(a, b) {
  a = rec(a); b = rec(b);
  if (!a) return b ? { ...b, n: num(b.n) || 1 } : null;
  if (!b) return a;
  const sum = (k) => (has(a[k]) || has(b[k]) ? num(a[k]) + num(b[k]) : null);
  return { input: num(a.input) + num(b.input), cached: sum('cached'), written: sum('written'), output: num(a.output) + num(b.output), n: (num(a.n) || 1) + (num(b.n) || 1) };
}

// The meta line's readout: 'cached 92%' when some of the prompt came from the provider's cache, else ''. A cold request
// (the first of a thread, or one past the cache's lifetime) shows nothing.
export function cacheLabel(u) {
  u = rec(u);
  const input = num(u?.input), cached = Math.min(num(u?.cached), input);
  if (!input || !cached) return '';
  const pct = Math.max(1, Math.min(cached < input ? 99 : 100, Math.round((100 * cached) / input)));
  return `cached ${pct}%`;
}

// Its tooltip / spoken label: the token counts behind it.
export function usageTitle(u) {
  u = rec(u);
  if (!u || !num(u.input)) return '';
  const f = (n) => num(n).toLocaleString('en-US');
  const parts = [`${f(u.input)} input tokens`];
  if (has(u.cached)) parts.push(`${f(u.cached)} read from cache`);
  if (has(u.written) && num(u.written)) parts.push(`${f(u.written)} written to cache`);
  parts.push(`${f(u.output)} output`);
  if (num(u.n) > 1) parts.push(`${num(u.n)} requests`);
  return parts.join(' · ');
}

// A stable, opaque routing key for a thread's requests (OpenAI's and xAI's prompt_cache_key: requests that share it go to
// the server that holds their cached prefix). A hash, so the thread id (a timestamp) never leaves the device.
export function cacheKey(id) {
  if (typeof id !== 'string' || !id) return '';
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) { a = Math.imul(a ^ id.charCodeAt(i), 0x01000193); b = Math.imul(b ^ id.charCodeAt(i), 0x5bd1e995); b ^= b >>> 15; }
  return `at-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
