// Claude adapter: accepts the app's OpenAI-style chat body (optionally with tools), calls Claude through
// the official SDK, and streams back OpenAI-style SSE chunks so the client stays provider-agnostic.
// Tool calls stream as OpenAI `tool_calls` deltas; the final Claude content (incl. signed thinking blocks)
// is sent as `anthropic_content` so the next agent step can replay it unchanged.
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
      // Replay Claude's own turn verbatim (thinking blocks must come back unchanged).
      if (Array.isArray(m.anthropic_content) && m.anthropic_content.length) { out.push({ role: 'assistant', content: m.anthropic_content }); continue; }
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
  // Current models take adaptive thinking + effort; Haiku 4.5 predates both.
  if (!/haiku/.test(model)) {
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

// workspaceId: needed only for org-level keys that aren't scoped to a workspace.
// tester (LinkedIn testers only): {maxTokens, webUses, fallbacks, onUsage}. One round only (no pause_turn continuation);
// onUsage(list of final.usage, true) runs once when the answer completes. When it fails or is cancelled,
// onUsage(list, false) reports what Claude had already counted (message_start / message_delta usage), or null.
export async function claudeChat(body, apiKey, workspaceId, tester = null) {
  const client = new Anthropic({
    apiKey,
    maxRetries: 1,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
  let params = buildParams(body, tester);
  const rounds = tester ? 1 : 4, usage = [];
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
      let toolIndex = -1;
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
          toolIndex++;
          delta({ tool_calls: [{ index: toolIndex, id: ev.content_block.id, type: 'function', function: { name: ev.content_block.name, arguments: '' } }] });
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') delta({ content: ev.delta.text });
          else if (ev.delta.type === 'thinking_delta') delta({ reasoning_content: ev.delta.thinking });
          else if (ev.delta.type === 'input_json_delta') delta({ tool_calls: [{ index: toolIndex, function: { arguments: ev.delta.partial_json } }] });
        } else if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'refusal') {
          delta({ content: '\n\n_Claude declined to continue this request._' });
        }
      };
      try {
        // A long server-side search can pause the turn; continue it (up to 3 times) so the answer completes.
        for (let round = 0; round < rounds; round++) {
          if (round > 0) cur = await open(params);
          if (!cur.first.done) handle(cur.first.value);
          for (let r = await cur.iter.next(); !r.done; r = await cur.iter.next()) handle(r.value);
          const final = await cur.stream.finalMessage();
          usage.push(final.usage);
          partial = null;
          if (final.stop_reason === 'pause_turn' && round < rounds - 1) {
            params = { ...params, messages: [...params.messages, { role: 'assistant', content: final.content }] };
            continue;
          }
          delta({ anthropic_content: final.content }, final.stop_reason === 'tool_use' ? 'tool_calls' : 'stop');
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
