// Claude adapter: accepts the app's OpenAI-style chat body (optionally with tools), calls Claude through
// the official SDK, and streams back OpenAI-style SSE chunks so the client stays provider-agnostic.
// Text and thinking stream as `content` / `reasoning_content` deltas. Tool calls go out as OpenAI `tool_calls` when the
// turn ends with stop_reason tool_use (whole, from the final message: never a half-written or declined call), and the
// final Claude content (incl. signed thinking blocks) is sent as `anthropic_content` so the next agent step can replay it
// unchanged. Every stop_reason maps to a finish_reason the app acts on (STOPS below): max_tokens → 'length' (the
// app's empty-answer rescue and "hit the length limit" note), refusal / model_context_window_exceeded → a clear note or
// error, never a blank, and pause_turn → continued here, the documented way.
import Anthropic from '@anthropic-ai/sdk';

// Models that accept the server-side refusal fallback ("default" routes by refusal category).
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// LinkedIn testers may ask for up to "high" (addendum A3); max_tokens still bounds what a call can cost.
const TESTER_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

function toClaudeContent(content) {
  if (typeof content === 'string') return content;
  return (content || [])
    .map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') {
        const url = part.image_url?.url || '';
        const m = url.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
        return m
          ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
          : { type: 'image', source: { type: 'url', url } };
      }
      return null;
    })
    .filter(Boolean);
}

const parseArgs = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

// After a mid-answer server-side fallback (a `fallback` block marks each switch), what the declined model wrote before
// the last switch can't all go back: its thinking, its tool calls, a server tool call left without its result, and any
// other model-internal block are dropped; text, paired server-tool blocks and the fallback markers stay, and everything
// after the last switch is unchanged (claude-api skill, shared/model-migration.md → refusal stop reason → "Echoing
// fallback turns back"). A list without a fallback block comes back as it is.
// The rule is for a turn as a whole. A paused turn continued server-side has several rounds, which go back as
// consecutive assistant messages that the API reads as one turn, and a paused round's last search gets its result at the
// start of the next round: so the last switch, and which server calls have their results, are found across all of the
// rounds (turnAfterFallback). Rounds keep their boundaries; a round left empty is dropped.
const isResult = (b) => /_tool_result$/.test(b?.type || '') && typeof b.tool_use_id === 'string';
const isServerUse = (b) => /^(?:server|mcp)_tool_use$/.test(b?.type || '');
export function turnAfterFallback(rounds) {
  const flat = rounds.flat();
  const cut = flat.findLastIndex((b) => b?.type === 'fallback');
  if (cut < 0) return rounds;
  const answered = new Set(flat.filter(isResult).map((b) => b.tool_use_id));
  const kept = new Set(flat.slice(0, cut).filter((b) => isServerUse(b) && answered.has(b.id)).map((b) => b.id));
  const keep = (b) => b?.type === 'text' || b?.type === 'fallback' || (isServerUse(b) && kept.has(b.id)) || (isResult(b) && kept.has(b.tool_use_id));
  let at = 0;
  return rounds.map((r) => r.filter((b) => at++ >= cut || keep(b))).filter((r) => r.length);
}
export const afterFallback = (blocks) => (Array.isArray(blocks) ? turnAfterFallback([blocks])[0] || [] : blocks);
// anthropic_content as the app keeps it: one round's blocks, or (a paused turn continued server-side) a list of rounds,
// which go back as consecutive assistant messages exactly as they were sent while continuing.
export const roundsOf = (content) => (Array.isArray(content) && content.length ? (Array.isArray(content[0]) ? content : [content]) : []);

function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant') {
      // Replay Claude's own turn verbatim (thinking blocks must come back unchanged; the history-editing check rejects
      // edited ones), round by round, minus what a declined model wrote before the turn's last fallback. claudeChat
      // already sends the turn in that form; filtering again changes nothing.
      const rounds = turnAfterFallback(roundsOf(m.anthropic_content).filter((r) => Array.isArray(r) && r.length));
      if (rounds.length) { for (const r of rounds) out.push({ role: 'assistant', content: r }); continue; }
      const content = [];
      if (m.content) content.push({ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      for (const tc of m.tool_calls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
      out.push({ role: 'assistant', content: content.length ? content : '…' });
      continue;
    }
    out.push({ role: 'user', content: toClaudeContent(m.content) });
  }
  return out;
}

// Each Claude model's official output maximum (max_tokens; thinking counts inside it): 128K for all four models Atelier
// lists (platform.claude.com/docs/en/about-claude/models/overview, read 2026-10-08). Values that large need streaming
// (the SDKs refuse a non-streaming request expected to run past 10 minutes); claudeChat always streams. A Claude id that
// isn't listed (one typed in Settings) keeps the earlier 64K ceiling: its own maximum isn't known here, and a max_tokens
// above a model's limit is rejected.
export const CLAUDE_MAX_OUTPUT = Object.freeze({ 'claude-opus-5-5': 128_000, 'claude-sonnet-5-5': 128_000, 'claude-fable-5-1': 128_000, 'claude-haiku-5-5': 128_000 });
export const CLAUDE_UNLISTED_MAX = 64_000;
export const claudeMaxOutput = (model) => (Object.hasOwn(CLAUDE_MAX_OUTPUT, model) ? CLAUDE_MAX_OUTPUT[model] : CLAUDE_UNLISTED_MAX);

// ── prompt caching (claude-api skill, shared/prompt-caching.md; platform.claude.com prompt-caching and pricing, read
// 2026-10-08) ──
// A request renders tools → system → messages, and a cache read needs that exact prefix up to a breakpoint (at most 4
// per request; each looks back at most 20 blocks for an entry an earlier request wrote). public/app.js keeps the prefix
// still from turn to turn: the date (not the time) in the system prompt, each turn's send time in its own message, the
// memory fixed for the run, the history trimmed in blocks. Here the breakpoints go on:
//   1. the system prompt — caches tools + system, shared by every thread with the same tools, settings and date
//   2. the last message before the turn — the history a request shares with the one before even when the turn itself
//      goes back differently: a retry (a new send time), a follow-up whose earlier photos went to a text-only model as a
//      note (its replay is the plain prompt). (Photos or frames in a request — added or removed anywhere — invalidate
//      the messages cache by the docs' table, so that turn and the next read the tools + system entry only.)
//   3. the turn's own user message — what the next turn reads when it replays as sent, and what every later round of
//      the same answer (the agent's tool rounds, a paused turn's continuation) builds on
//   4. top-level automatic caching, only when messages go on past the turn (tool rounds, a continuation): it lands on
//      the last cacheable block, so the next round reads this one. Never with 3 on the last block (a second marker there
//      with another TTL is a 400).
// TTL. The owner's 1-3 use the 1-hour cache: a follow-up often starts 5-60 minutes after the request before it started
// (reading time, a long Code answer generating for minutes), when a 5-minute entry is gone and the whole thread is
// written again at 1.25x; a 1-hour write costs 2x on the new tokens only, and reads cost 0.05x input on Opus 5.5 and
// Sonnet 5.5 (0.025x Fable 5.1, 0.1x Haiku 5.5). 4 is 5-minute by default: a paused turn's continuation follows at once,
// and an agent round follows the one before as soon as its tools have run — unless a step waits for the user's OK. An
// approval longer than 5 minutes (counted from the start of the round before) loses that round's tail, and the next round
// writes every round since the turn again (it still reads the turn's 1-hour entry). So the app sends cache_tail '1h' on a
// run whose reads all wait for the OK (public/app.js runAgent: outside text in the thread or the turn, a web search or an
// outside page / chat read earlier in the run), and 4 is then 1-hour too (after 1-hour markers, so a longer TTL still
// never follows a shorter one). A clean run's writes wait as well, but most of its rounds don't: those keep the cheaper
// 5 minutes and accept that miss. Testers: every marker 5-minute, the write rate src/tester/prices.js reserves at.
// No marker where it can't pay: on a prefix shorter than the model's minimum (the API caches nothing there) or on a call
// whose prompt is never sent again (body.cache === false, public/app.js streamChatRaw: titles, memory, prompt polish,
// routing, Build, Ideas, Remix plans, a nudge at a changed effort — a write there would never be read).
// Minimum cacheable prompt per model (prompt-caching docs, read 2026-10-08); an id not listed: 1,024.
const CACHE_MIN = Object.freeze({
  'claude-fable-5-1': 512, 'claude-mythos-5-1': 512, 'claude-opus-5-5': 512, 'claude-sonnet-5-5': 512, 'claude-haiku-5-5': 512,
  'claude-opus-5': 512, 'claude-fable-5': 512, 'claude-mythos-5': 512,
  'claude-opus-4-8': 1024, 'claude-sonnet-5': 1024, 'claude-sonnet-4-6': 1024, 'claude-sonnet-4-5': 1024,
  'claude-opus-4-7': 2048, 'claude-opus-4-6': 4096, 'claude-opus-4-5': 4096, 'claude-haiku-4-5': 4096,
});
export const cacheMin = (model) => (Object.hasOwn(CACHE_MIN, model) ? CACHE_MIN[model] : 1024);
// A generous token estimate (3 characters a token, an image 1,600): guessing high only ever marks a prefix the API then
// leaves uncached (no write is billed); guessing low would skip one it would have cached.
const IMAGE_TOKENS = 1600;
function tokensOf(v) {
  if (typeof v === 'string') return Math.ceil(v.length / 3);
  if (Array.isArray(v)) return v.reduce((n, x) => n + tokensOf(x), 0);
  if (!v || typeof v !== 'object') return 0;
  if (v.type === 'image' || v.type === 'document') return IMAGE_TOKENS;
  return Math.ceil(JSON.stringify(v).length / 3);
}
const CACHEABLE = new Set(['text', 'image', 'document', 'tool_use', 'tool_result']);
const isToolResults = (m) => Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b?.type === 'tool_result');
// m with cache_control on its last block that can carry one, as a new message (the body's own objects stay as they were);
// null when it has none. A replayed Claude turn that holds thinking (signed blocks) is left alone: the marker is never
// needed there (the history replays answers as text), and that turn goes back exactly as Claude wrote it.
const SIGNED = new Set(['thinking', 'redacted_thinking']);
function marked(m, cc) {
  if (typeof m.content === 'string') return /\S/.test(m.content) ? { ...m, content: [{ type: 'text', text: m.content, cache_control: cc }] } : null;
  if (!Array.isArray(m.content) || (m.role === 'assistant' && m.content.some((b) => SIGNED.has(b?.type)))) return null;
  for (let i = m.content.length - 1; i >= 0; i--) {
    const b = m.content[i];
    if (CACHEABLE.has(b?.type) && !(b.type === 'text' && !/\S/.test(b.text || ''))) return { ...m, content: m.content.map((x, k) => (k === i ? { ...x, cache_control: cc } : x)) };
  }
  return null;
}
// Places breakpoints 1-3 on params (system becomes a block list when it is marked). → whether caching is on for it.
function placeCache(params, { tester, off }) {
  if (off) return false;
  const min = cacheMin(params.model), cc = tester ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
  let size = tokensOf(params.tools || []) + tokensOf(params.system || '');
  if (params.system && size >= min) params.system = [{ type: 'text', text: params.system, cache_control: cc }];
  const msgs = params.messages, turn = msgs.findLastIndex((m) => m.role === 'user' && !isToolResults(m));
  const upTo = msgs.map((m) => (size += tokensOf(m.content)));
  for (const i of [turn - 1, turn]) {
    if (i < 0 || upTo[i] < min) continue;
    const m = marked(msgs[i], cc);
    if (m) msgs[i] = m;
  }
  return true;
}
// Breakpoint 4 for params as they are now: automatic caching with cc (null: caching is off) when messages go on past the
// turn and the whole prompt can be cached; otherwise none.
function withTail(params, cc) {
  const { cache_control, ...rest } = params;
  if (!cc) return rest;
  const msgs = rest.messages, turn = msgs.findLastIndex((m) => m.role === 'user' && !isToolResults(m));
  const size = tokensOf(rest.tools || []) + tokensOf(rest.system || '') + tokensOf(msgs.map((m) => m.content));
  return turn < msgs.length - 1 && size >= cacheMin(rest.model) ? { ...rest, cache_control: cc } : rest;
}

// tester (LinkedIn testers only): {maxTokens, webUses, fallbacks} as the tester router priced them.
function buildParams(body, tester = null) {
  const model = body.model.replace(/^anthropic:/, '');
  const system = body.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');

  let maxTokens = Math.min(Math.max(body.max_tokens || 16000, 1024), claudeMaxOutput(model));
  if (tester) maxTokens = Math.min(maxTokens, Math.max(tester.maxTokens || 0, 1024)); // the reserve was priced at this cap
  const params = { model, max_tokens: maxTokens, messages: toClaudeMessages(body.messages) };
  if (system) params.system = system;
  if (!tester && Array.isArray(body.tools) && body.tools.length) {
    params.tools = body.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  }
  // Current models take adaptive thinking + effort (Claude Haiku 5.5 included: effort low–max, default medium); only
  // Haiku 4.5 and older predate both. No sampling parameters are ever sent: since Opus 4.7, non-default temperature /
  // top_p / top_k return a 400 (Haiku 5.5 and Sonnet 5.5 too), so body.temperature is deliberately not read here.
  if (!/^claude-(?:3|haiku-4)/.test(model)) {
    params.thinking = { type: 'adaptive', display: 'summarized' };
    const effort = EFFORTS.has(body.reasoning_effort) ? body.reasoning_effort : 'medium';
    params.output_config = { effort: tester ? TESTER_EFFORT[effort] : effort };
  }
  // Live web search for time-sensitive questions (Anthropic-hosted server tool). Testers: the max_uses that was priced.
  const uses = tester ? tester.webUses || 0 : 5;
  if (body.web_search && uses > 0) params.tools = [...(params.tools || []), { type: 'web_search_20260209', name: 'web_search', max_uses: uses }];
  // Cache the stable prefix (tools + system, the history, the turn) so follow-ups start faster and cost less (placeCache).
  // A refusal fallback (fallbacks 'default') re-runs this same body on the fallback model, markers included, and caches
  // in that model's own cache.
  // cached: breakpoint 4's cache_control for this body and its continuations; null with caching off.
  const cached = !placeCache(params, { tester, off: body.cache === false }) ? null
    : body.cache_tail === '1h' && !tester ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
  if (FALLBACK_MODELS.has(model) && (!tester || tester.fallbacks !== false)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return { params: withTail(params, cached), cached };
}

const isWebTool = (t) => typeof t.type === 'string' && t.type.startsWith('web_search');
const errorResponse = (err) => new Response(JSON.stringify({ error: err.error?.error?.message || err.message || 'Claude request failed' }), {
  status: err instanceof Anthropic.APIError && err.status ? err.status : 502,
  headers: { 'content-type': 'application/json' },
});

// Messages API stop_reason → what the app gets (platform.claude.com/docs/en/build-with-claude/handling-stop-reasons):
//   finish   the OpenAI-style finish_reason. 'length' = cut short (the app notes it, and rescues a reply that only
//            thought); 'content_filter' = declined (the agent never runs a call from such a turn).
//   note     appended to an answer that already shows text; error/code: sent instead (an SSE error) when nothing visible
//            came, so a refused or overflowing turn is never a blank. The app maps code to a status (public/app.js
//            SSE_ERRORS): 'refusal' reads as "Try rephrasing" and is not retried on another provider.
// pause_turn reaches the app only when continuing stopped (see claudeChat): the answer is incomplete, so 'length'.
// Anything else (a value newer than this list, or none) ends as 'stop': if it showed nothing, the app's rescue runs.
export const STOPS = {
  end_turn: { finish: 'stop' },
  stop_sequence: { finish: 'stop' },
  tool_use: { finish: 'tool_calls' },
  max_tokens: { finish: 'length' },
  pause_turn: { finish: 'length' },
  refusal: {
    finish: 'content_filter', code: 'refusal',
    note: 'Claude stopped here: its safety checks declined to continue this request.',
    error: 'Claude declined this request: its safety checks flagged it. Try rephrasing it, or ask another model.',
  },
  model_context_window_exceeded: {
    finish: 'stop', code: 'context_window',
    note: 'Claude stopped here: this conversation filled its context window. Start a new thread to go on.',
    error: 'This conversation is longer than Claude can read at once. Start a new thread, or attach less.',
  },
};
// A paused server-tool turn (web search) is continued at most this many times (docs: bound the loop; the server already
// runs up to 10 sampling iterations per request). Testers get none: their reservation is priced for one request.
export const PAUSE_CONTINUATIONS = 3;
// A turn that stopped for tool_use → its calls as OpenAI tool_calls, whole (from the last round's tool_use blocks, as the
// turn goes back: only the ones after its last fallback switch).
const callsOf = (blocks) => (blocks || []).filter((b) => b?.type === 'tool_use')
  .map((b, index) => ({ index, id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));

// workspaceId: needed only for org-level keys that aren't scoped to a workspace.
// tester (LinkedIn testers only): {maxTokens, webUses, fallbacks, onUsage}. One round only (no pause_turn continuation:
// a paused answer ends as 'length', and the app says to ask "continue"); onUsage(list of final.usage, true) runs once
// when the answer completes. When it fails or is cancelled, onUsage(list, false) reports what Claude had already
// counted (message_start / message_delta usage), or null.
export async function claudeChat(body, apiKey, workspaceId, tester = null) {
  const client = new Anthropic({
    apiKey,
    maxRetries: 1,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
  let { params, cached } = buildParams(body, tester);
  const rounds = tester ? 1 : 1 + PAUSE_CONTINUATIONS, usage = [];
  // What the app's cache readout gets (public/usage.js readUsage): every round's tokens, added up.
  const usageOut = () => {
    const sum = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    for (const u of usage) for (const k of Object.keys(sum)) { const n = Number(u?.[k]); if (Number.isFinite(n) && n > 0) sum[k] += n; }
    return sum;
  };
  let reported = false, partial = null; // partial: this round's usage so far, until its finalMessage
  const report = (list, complete = true) => { if (reported || !tester?.onUsage) return undefined; reported = true; return Promise.resolve().then(() => tester.onUsage(list, complete)).catch(() => {}); };
  const soFar = () => (partial ? [...usage, partial] : usage.length ? [...usage] : null);
  // Pull the first event before answering so auth/model errors surface as real HTTP statuses.
  const open = async (p) => {
    const stream = client.beta.messages.stream(p);
    const iter = stream[Symbol.asyncIterator]();
    return { stream, iter, first: await iter.next() };
  };
  let cur;
  try {
    cur = await open(params);
  } catch (err) {
    // Web search may be disabled for the org — answer without it rather than failing.
    if (err.status !== 400 || !params.tools?.some(isWebTool)) return errorResponse(err);
    params = { ...params, tools: params.tools.filter((t) => !isWebTool(t)) };
    if (!params.tools.length) delete params.tools;
    try { cur = await open(params); } catch (err2) { return errorResponse(err2); }
  }

  const enc = new TextEncoder();
  const body$ = new ReadableStream({
    async start(ctrl) {
      const send = (obj) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const delta = (d, finish = null) => send({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
      let visible = false; // this turn showed answer text (thinking alone is not an answer)
      const handle = (ev) => {
        if (ev.type === 'message_start' && ev.message?.usage) partial = { ...ev.message.usage };
        else if (ev.type === 'message_delta' && ev.usage) {
          partial = { ...partial };
          for (const [k, v] of Object.entries(ev.usage)) if (v != null) partial[k] = v; // a null counter keeps the earlier count
        }
        if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') {
          // web_searches: the client labels a turn "live web" only when Claude actually searched, not when search was offered.
          delta({ status: 'Searching the web', ...(ev.content_block.name === 'web_search' ? { web_searches: 1 } : {}) });
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          // The call itself goes out whole when the turn ends (callsOf); this keeps the app's first-token timer satisfied.
          delta({ status: 'Preparing a step' });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta' && ev.delta.text) { if (/\S/.test(ev.delta.text)) visible = true; delta({ content: ev.delta.text }); }
          else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) delta({ reasoning_content: ev.delta.thinking });
        }
      };
      // The turn's end, by stop_reason (STOPS). turn: each round's content as it goes back (more than one when a pause
      // was continued).
      const end = (stop, turn) => {
        send({ usage: usageOut() }); // no choices: the app reads it beside the deltas (streamChatRaw)
        const how = Object.hasOwn(STOPS, stop ?? '') ? STOPS[stop] : STOPS.end_turn;
        if (how.error && !visible) return send({ error: { message: how.error, code: how.code } });
        if (how.note) delta({ content: `\n\n_${how.note}_` });
        const calls = stop === 'tool_use' ? callsOf(turn.at(-1)) : [];
        if (calls.length) delta({ tool_calls: calls });
        delta({ anthropic_content: turn.length > 1 ? turn : turn[0] }, how.finish);
      };
      try {
        // A long server-side search can pause the turn (pause_turn): send the content back as it is, with no extra user
        // message, and the server resumes where it left off; up to PAUSE_CONTINUATIONS times. "As it is" is the turn so
        // far in the form it goes back in (turnAfterFallback over every round, so a fallback in a later round also
        // drops what the declined model wrote in an earlier one): the continuation request and the app's later replay
        // (anthropic_content) carry the same blocks.
        const turn = [], base = params.messages;
        for (let round = 0; round < rounds; round++) {
          if (round > 0) cur = await open(params);
          if (!cur.first.done) handle(cur.first.value);
          for (let r = await cur.iter.next(); !r.done; r = await cur.iter.next()) handle(r.value);
          const final = await cur.stream.finalMessage();
          usage.push(final.usage);
          partial = null;
          turn.push(final.content);
          const back = turnAfterFallback(turn);
          if (final.stop_reason === 'pause_turn' && round < rounds - 1) {
            // The continuation keeps breakpoints 1-3 (they are in base) and gets the automatic one on the paused content,
            // so it reads the turn's cached prefix and the search results the server cached after them.
            params = withTail({ ...params, messages: [...base, ...back.map((content) => ({ role: 'assistant', content }))] }, cached);
            continue;
          }
          end(final.stop_reason, back);
          break;
        }
        await report(usage);
      } catch (err) {
        send({ error: { message: err.error?.error?.message || err.message || 'Claude stream failed' } });
        await report(soFar(), false);
      }
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
    cancel() {
      report(soFar(), false);
      cur?.stream.abort();
    },
  });

  return new Response(body$, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
