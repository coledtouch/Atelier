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

// tester (LinkedIn testers only): {maxTokens, webUses, fallbacks} as the tester router priced them.
function buildParams(body, tester = null) {
  const model = body.model.replace(/^anthropic:/, '');
  const system = body.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n\n');

  let maxTokens = Math.min(Math.max(body.max_tokens || 16000, 1024), 64000);
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
  // Cache the stable prefix (system prompt + earlier turns) so follow-ups start faster and cost less.
  params.cache_control = { type: 'ephemeral' };
  if (FALLBACK_MODELS.has(model) && (!tester || tester.fallbacks !== false)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
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
  let params = buildParams(body, tester);
  const rounds = tester ? 1 : 1 + PAUSE_CONTINUATIONS, usage = [];
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
            params = { ...params, messages: [...base, ...back.map((content) => ({ role: 'assistant', content }))] };
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
