// Claude's stop reasons, end to end. src/anthropic.js maps every Messages API stop_reason to the finish_reason, note or
// error the app acts on (max_tokens → 'length', refusal and model_context_window_exceeded → never a blank, pause_turn →
// continued the documented way), and public/app.js's streamChat counts only visible text or tool calls as an answer, so
// a Claude reply that only thought gets the v67 rescue (EMPTY_NUDGE at effort low, then the next model) like every other
// provider. The Anthropic API is a fetch mock (no real call is ever made); app.js functions are lifted out and run
// against stubs, as tests/untrusted-turns.test.mjs does, with the real Worker adapter behind the client's fetch.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { claudeChat, afterFallback, turnAfterFallback, STOPS, PAUSE_CONTINUATIONS } from '../src/anthropic.js';
import { followUpRoute, threadTaint, ownTaint, taintGates, taintNote, readsPage, pageOrigin, worseTaint, buildHistory } from '../public/context.js';
import { isTesterCode } from '../public/tester.js';
import { chatWorstCase } from '../src/tester/prices.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ── the Anthropic Messages API, mocked ──
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const sigOf = (b) => b.signature || `sig-${b.thinking.length}`;
// blocks → a Messages API stream ending with stop_reason `stop` (stop_details only on a refusal).
function claudeSSE(blocks, stop, { details = null, model = 'claude-opus-5-5' } = {}) {
  const out = [ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })];
  blocks.forEach((b, index) => {
    if (b.type === 'thinking') {
      out.push(ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }),
        ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } }),
        ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: sigOf(b) } }));
    } else if (b.type === 'text') {
      out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }));
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      out.push(ev('content_block_start', { index, content_block: { type: b.type, id: b.id, name: b.name, input: {} } }),
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: b.json ?? JSON.stringify(b.input) } }));
    } else out.push(ev('content_block_start', { index, content_block: b })); // redacted_thinking, server tool results, fallback
    out.push(ev('content_block_stop', { index }));
  });
  out.push(ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null, ...(details ? { stop_details: details } : {}) }, usage: { output_tokens: 20 } }), ev('message_stop', {}));
  return new Response(out.join(''), { headers: { 'content-type': 'text/event-stream' } });
}
// Each Anthropic request gets the next reply (the last one repeats); every request body is kept.
function anthropic(...replies) {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    assert.match(req.url, /^https:\/\/api\.anthropic\.com\//, 'only the mocked Anthropic API');
    sent.push(JSON.parse(await req.text()));
    return replies[Math.min(sent.length - 1, replies.length - 1)](sent.at(-1));
  };
  return sent;
}
const T = (text) => ({ type: 'text', text });
const TH = (thinking, signature) => ({ type: 'thinking', thinking, ...(signature ? { signature } : {}) });
const USE = (id, name, input, json) => ({ type: 'tool_use', id, name, input, ...(json ? { json } : {}) });
const thinkOnly = () => claudeSSE([TH('Planning the files, the tests, the edge cases… ')], 'max_tokens');

// The Worker's SSE → what the app reads from it.
async function workerOut(res) {
  const chunks = (await res.text()).split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const deltas = chunks.filter((c) => c.choices).map((c) => ({ ...c.choices[0].delta, finish: c.choices[0].finish_reason }));
  return {
    text: deltas.map((d) => d.content || '').join(''), reasoning: deltas.map((d) => d.reasoning_content || '').join(''),
    finish: deltas.map((d) => d.finish).filter(Boolean), calls: deltas.filter((d) => d.tool_calls).map((d) => d.tool_calls),
    status: deltas.map((d) => d.status).filter(Boolean), replay: deltas.find((d) => d.anthropic_content)?.anthropic_content,
    error: chunks.find((c) => c.error)?.error || null,
  };
}
const chat = (body = {}, tester) => claudeChat({ model: 'anthropic:claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], ...body }, 'sk-ant-test', undefined, tester);

// ── src/anthropic.js: every stop_reason ──
test('Worker: end_turn and stop_sequence end as stop; max_tokens as length, with text or when Claude only thought', async () => {
  for (const stop of ['end_turn', 'stop_sequence']) {
    anthropic(() => claudeSSE([TH('hmm'), T('The answer.')], stop));
    const o = await workerOut(await chat());
    assert.deepEqual([o.text, o.reasoning, o.finish, o.error], ['The answer.', 'hmm', ['stop'], null], stop);
    assert.deepEqual(o.replay.map((b) => b.type), ['thinking', 'text'], 'the whole turn comes back for replay');
  }
  anthropic(() => claudeSSE([TH('long plan'), T('Part one of the fi')], 'max_tokens'));
  let o = await workerOut(await chat());
  assert.deepEqual([o.text, o.finish], ['Part one of the fi', ['length']]);
  anthropic(thinkOnly);
  o = await workerOut(await chat());
  assert.deepEqual([o.text, o.finish, o.error], ['', ['length'], null], 'thinking only: no text, finish length, so the app can rescue it');
  assert.ok(o.reasoning.length > 0);
  assert.deepEqual(o.replay.map((b) => b.type), ['thinking']);
});

test('Worker: tool_use sends each call whole at the end (finish tool_calls); a call cut at max_tokens is never sent', async () => {
  anthropic(() => claudeSSE([TH('look it up'), USE('toolu_1', 'gmail_search', { q: 'is:unread' }), USE('toolu_2', 'gmail_search', { q: 'from:bank' })], 'tool_use'));
  let o = await workerOut(await chat({ tools: [{ type: 'function', function: { name: 'gmail_search', description: 'x', parameters: { type: 'object' } } }] }));
  assert.deepEqual(o.calls, [[
    { index: 0, id: 'toolu_1', type: 'function', function: { name: 'gmail_search', arguments: '{"q":"is:unread"}' } },
    { index: 1, id: 'toolu_2', type: 'function', function: { name: 'gmail_search', arguments: '{"q":"from:bank"}' } },
  ]], 'one tool_calls delta, after the stream, with complete arguments');
  assert.deepEqual(o.finish, ['tool_calls']);
  assert.deepEqual(o.status, ['Preparing a step', 'Preparing a step'], 'a status per call keeps the first-token timer fed');
  assert.deepEqual(o.replay.map((b) => b.type), ['thinking', 'tool_use', 'tool_use']);
  anthropic(() => claudeSSE([T('Drafting the email now.'), USE('toolu_3', 'gmail_draft', {}, '{"body": "Dear Sam, about the inv')], 'max_tokens'));
  o = await workerOut(await chat());
  assert.deepEqual([o.calls, o.finish, o.text], [[], ['length'], 'Drafting the email now.'], 'a half-written call never reaches the agent');
});

test('Worker: a refusal is never a blank — an error the app shows when nothing came, a note on a partial answer', async () => {
  const details = { type: 'refusal', category: 'cyber', explanation: 'flagged' };
  anthropic(() => claudeSSE([], 'refusal', { details }));
  let o = await workerOut(await chat());
  assert.deepEqual(o.error, { message: STOPS.refusal.error, code: 'refusal' });
  assert.deepEqual([o.text, o.finish], ['', []]);
  anthropic(() => claudeSSE([TH('…'), T('Here is the first part')], 'refusal', { details }));
  o = await workerOut(await chat());
  assert.equal(o.error, null);
  assert.equal(o.text, `Here is the first part\n\n_${STOPS.refusal.note}_`);
  assert.deepEqual(o.finish, ['content_filter']);
  // thinking alone isn't an answer: still the error
  anthropic(() => claudeSSE([TH('considering')], 'refusal', { details }));
  o = await workerOut(await chat());
  assert.equal(o.error?.code, 'refusal');
});

test('Worker: model_context_window_exceeded → a clear error, or a note on the text it got; an unknown stop_reason ends as stop', async () => {
  anthropic(() => claudeSSE([TH('so much context')], 'model_context_window_exceeded'));
  let o = await workerOut(await chat());
  assert.deepEqual(o.error, { message: STOPS.model_context_window_exceeded.error, code: 'context_window' });
  anthropic(() => claudeSSE([T('The summary so f')], 'model_context_window_exceeded'));
  o = await workerOut(await chat());
  assert.deepEqual([o.text, o.finish], [`The summary so f\n\n_${STOPS.model_context_window_exceeded.note}_`, ['stop']]);
  anthropic(() => claudeSSE([T('fine')], 'a_value_added_later'));
  o = await workerOut(await chat());
  assert.deepEqual([o.text, o.finish, o.error], ['fine', ['stop'], null]);
  anthropic(() => claudeSSE([TH('…')], 'a_value_added_later'));
  o = await workerOut(await chat());
  assert.deepEqual([o.text, o.finish, o.error], ['', ['stop'], null], 'nothing shown: the app’s rescue takes it from here');
});

const SEARCH = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } };
const RESULTS = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A', encrypted_content: 'enc', page_age: null }] };
test('Worker: pause_turn is continued with the paused content as it is (no extra user message), at most 3 times; the rounds replay in order', async () => {
  const sent = anthropic(
    () => claudeSSE([TH('search first'), SEARCH, RESULTS, T('Found it. ')], 'pause_turn'),
    () => claudeSSE([T('Today’s headline is A.')], 'end_turn'));
  const o = await workerOut(await chat({ web_search: true, messages: [{ role: 'user', content: 'news today?' }] }));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].messages.map((m) => m.role), ['user', 'assistant'], 'the continuation ends with the paused assistant turn');
  assert.deepEqual(sent[1].messages[1].content.map((b) => b.type), ['thinking', 'server_tool_use', 'web_search_tool_result', 'text']);
  assert.ok(sent[1].tools.some((t) => t.type === 'web_search_20260209'), 'same tools');
  assert.deepEqual([o.text, o.finish, o.status], ['Found it. Today’s headline is A.', ['stop'], ['Searching the web']]);
  assert.equal(o.replay.length, 2, 'a continued turn keeps its rounds');
  assert.deepEqual(o.replay.map((r) => r.map((b) => b.type)), [['thinking', 'server_tool_use', 'web_search_tool_result', 'text'], ['text']]);
  // replayed later as consecutive assistant messages, exactly as sent while continuing
  const again = anthropic(() => claudeSSE([T('ok')], 'end_turn'));
  await (await chat({ messages: [{ role: 'user', content: 'news today?' }, { role: 'assistant', content: 'x', anthropic_content: o.replay }, { role: 'user', content: 'and sport?' }] })).text();
  assert.deepEqual(again[0].messages.map((m) => m.role), ['user', 'assistant', 'assistant', 'user']);
  assert.deepEqual(again[0].messages[1].content, sent[1].messages[1].content, 'round 1 unchanged, signature included');
  // capped: a turn that keeps pausing stops after 1 + PAUSE_CONTINUATIONS requests, as 'length' (incomplete)
  const capped = anthropic(() => claudeSSE([SEARCH, RESULTS, T('still looking… ')], 'pause_turn'));
  const c = await workerOut(await chat({ web_search: true }));
  assert.equal(capped.length, 1 + PAUSE_CONTINUATIONS);
  assert.deepEqual(c.finish, ['length']);
});

test('Worker: a tester’s paused turn is not continued (priced as one request) and ends as length', async () => {
  const sent = anthropic(() => claudeSSE([SEARCH, RESULTS, T('Partly there. ')], 'pause_turn'));
  let usage = null;
  const o = await workerOut(await chat({ web_search: true, max_tokens: 2000 }, { maxTokens: 2000, webUses: 1, fallbacks: false, onUsage: (u, complete) => { usage = { n: u.length, complete }; } }));
  assert.equal(sent.length, 1);
  assert.deepEqual([o.text, o.finish], ['Partly there. ', ['length']]);
  assert.equal(sent[0].max_tokens, 2000, 'the priced cap');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(usage, { n: 1, complete: true });
});

test('Worker: replay after a mid-answer fallback drops what the declined model can’t send back; everything else is verbatim', () => {
  const blocks = [TH('a'), { type: 'redacted_thinking', data: 'x' }, T('Partial '), USE('toolu_9', 'gmail_search', {}), SEARCH, RESULTS,
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: {} }, { type: 'mystery_block' },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, TH('b', 'sig-b'), USE('toolu_10', 'gmail_search', { q: 'x' })];
  assert.deepEqual(afterFallback(blocks).map((b) => b.type), ['text', 'server_tool_use', 'web_search_tool_result', 'fallback', 'thinking', 'tool_use']);
  assert.equal(afterFallback(blocks).find((b) => b.type === 'server_tool_use').id, 'srvtoolu_1', 'only the server call that has its result');
  const plain = [TH('a'), T('b')];
  assert.equal(afterFallback(plain), plain, 'no fallback: the same list');
});

test('Worker: the calls of a turn that fell back mid-answer are the fallback model’s only', async () => {
  anthropic(() => claudeSSE([USE('toolu_old', 'gmail_search', { q: 'half' }), { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, USE('toolu_new', 'gmail_search', { q: 'whole' })], 'tool_use'));
  const o = await workerOut(await chat());
  assert.deepEqual(o.calls.flat().map((c) => c.id), ['toolu_new']);
});

// A paused turn's rounds are one turn to the API (consecutive assistant messages merge), so the fallback rule runs over
// all of them: a search paused at the end of one round keeps the result the next round starts with.
const SRV = (n) => ({ type: 'server_tool_use', id: `srvtoolu_${n}`, name: 'web_search', input: { query: `q${n}` } });
const RES = (n) => ({ type: 'web_search_tool_result', tool_use_id: `srvtoolu_${n}`, content: [{ type: 'web_search_result', url: `https://example.com/${n}`, title: `R${n}`, encrypted_content: `enc${n}`, page_age: null }] });
const FB = { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } };
const unpaired = (blocks) => blocks.filter((b) => b.type === 'server_tool_use' && !blocks.some((r) => r.tool_use_id === b.id)).map((b) => b.id);
test('Worker: a fallback in a continued turn filters the turn as one unit; continuation requests and the replay carry the same blocks', async () => {
  assert.deepEqual(turnAfterFallback([[TH('a'), SRV(2)], [RES(2), T('t'), FB, USE('toolu_1', 'gmail_search', {})]]).map((r) => r.map((b) => b.type)),
    [['server_tool_use'], ['web_search_tool_result', 'text', 'fallback', 'tool_use']], 'the paused search keeps its result; the declined thinking goes');
  assert.deepEqual(turnAfterFallback([[TH('a')], [FB, T('b')]]), [[FB, T('b')]], 'a round left empty is dropped');
  const plain = [[TH('a'), SRV(1)], [RES(1), T('b')]];
  assert.equal(turnAfterFallback(plain), plain, 'no fallback: the same rounds');
  // three rounds: pause, pause after a fallback, then the answer
  const sent = anthropic(
    () => claudeSSE([TH('search first', 'sig-0'), SRV(2)], 'pause_turn', { model: 'claude-sonnet-5-5' }),
    () => claudeSSE([RES(2), T('Found the flight. '), FB, TH('more', 'sig-1'), SRV(3)], 'pause_turn', { model: 'claude-sonnet-5' }),
    () => claudeSSE([RES(3), T('It leaves at 9.')], 'end_turn', { model: 'claude-sonnet-5' }));
  const o = await workerOut(await chat({ model: 'anthropic:claude-sonnet-5-5', web_search: true, messages: [{ role: 'user', content: 'flight news?' }] }));
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1].messages.slice(1).map((m) => m.content.map((b) => b.type)), [['thinking', 'server_tool_use']], 'before any fallback: round 0 as it came');
  const second = sent[2].messages.slice(1);
  assert.deepEqual(second.map((m) => [m.role, m.content.map((b) => b.type)]), [
    ['assistant', ['server_tool_use']], ['assistant', ['web_search_tool_result', 'text', 'fallback', 'thinking', 'server_tool_use']]],
  'after the fallback: the declined model’s thinking is gone from round 0 too, srvtoolu_2 keeps its result, the paused srvtoolu_3 stays');
  assert.deepEqual(unpaired(second.flatMap((m) => m.content)), ['srvtoolu_3'], 'only the search the server resumes is open');
  assert.deepEqual([o.text, o.finish], ['Found the flight. It leaves at 9.', ['stop']]);
  assert.deepEqual(o.replay.slice(0, 2), second.map((m) => m.content), 'the replay is what the server was sent');
  assert.deepEqual(unpaired(o.replay.flat()), []);
});

test('Worker: a paused search, then a fallback and a tool call in the continuation — the next step replays a valid turn', async () => {
  const gmail = [{ type: 'function', function: { name: 'gmail_search', description: 'x', parameters: { type: 'object' } } }];
  const sent = anthropic(
    () => claudeSSE([TH('search first', 'sig-0'), SRV(2)], 'pause_turn', { model: 'claude-sonnet-5-5' }),
    () => claudeSSE([RES(2), T('Checking your mail. '), FB, USE('tu_1', 'gmail_search', { q: 'flight' })], 'tool_use', { model: 'claude-sonnet-5' }));
  const ask = [{ role: 'user', content: 'weather and my flight' }];
  const o = await workerOut(await chat({ model: 'anthropic:claude-sonnet-5-5', web_search: true, tools: gmail, messages: ask }));
  assert.equal(sent.length, 2);
  assert.deepEqual([o.finish, o.calls.flat().map((c) => c.id)], [['tool_calls'], ['tu_1']]);
  const step = { role: 'assistant', content: 'Checking your mail. ', tool_calls: o.calls.flat(), anthropic_content: o.replay };
  const next = anthropic(() => claudeSSE([T('At 9.')], 'end_turn'));
  await (await chat({ model: 'anthropic:claude-sonnet-5-5', tools: gmail, messages: [...ask, step, { role: 'tool', tool_call_id: 'tu_1', content: '[]' }] })).text();
  const msgs = next[0].messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'assistant', 'user']);
  const merged = msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.content);
  assert.deepEqual(merged.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text', 'fallback', 'tool_use'], 'the documented shape');
  assert.deepEqual(unpaired(merged), [], 'srvtoolu_2 has its result');
  assert.equal(msgs.at(-1).content[0].tool_use_id, 'tu_1');
});

// ── public/app.js, lifted ──
const APP = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function fnSource(name) {
  let at = APP.indexOf(`\nfunction ${name}(`);
  if (at < 0) at = APP.indexOf(`\nasync function ${name}(`);
  assert.ok(at >= 0, `app.js has function ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n}\n', at + 1) + 2);
}
// `const name = …;` up to the next line that starts at column 0 with anything but a closing bracket (so a const continued
// on indented lines, or closed by `});`, comes whole).
function constExpr(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `app.js has const ${name}`);
  const end = APP.slice(at + 1).search(/\n(?=[^\s})\]])/);
  return APP.slice(at + 1, at + 1 + end).replace(new RegExp(`^const ${name} = `), '').replace(/;\s*(?:\/\/[^\n]*)?$/, '');
}
function scope(vars) {
  return new Proxy(vars, {
    has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));
const CONSTS = ['EMPTY_NUDGE', 'shows', 'THINKING_BLOCKS', 'replayRounds', 'replayable', 'CLAUDE_ROOM', 'roomFor', 'SSE_ERRORS', 'EFFORT', 'FIRST_TOKEN_MS', 'providerOf', 'accountProblem', 'sleep', 'asksFirst', 'urlHost', 'githubOutside'];
const FNS = ['withoutThinking', 'streamChat', 'streamChatOnce', 'streamChatRaw', 'apiHeaders', 'toApiError', 'runChat', 'runAgent'];

// OpenAI-style providers (the Worker forwards their SSE as it is): script(body) → deltas, last one with finish.
const openaiSSE = (deltas) => new Response(deltas.map((d) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d.delta || {}, finish_reason: d.finish || null }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const DEFS = [{ name: 'gmail_search', service: 'gmail' }, { name: 'gmail_draft', service: 'gmail', write: true }]
  .map((d) => ({ type: 'function', function: { name: d.name, description: d.name, parameters: { type: 'object' } }, 'x-write': Boolean(d.write), 'x-label': d.name, 'x-service': d.service }));

// chains: role → model ids; other(body) answers non-Claude models. Returns the lifted functions and what happened.
function rig({ chains = {}, other = () => openaiSSE([{ delta: { content: 'other' } }, { finish: 'stop' }]), tester = null } = {}) {
  const calls = { bodies: [], toasts: [], tools: [], approvals: [] };
  const vars = {
    S: { settings: { temperature: 0.5, models: {}, passcode: 'p' }, tester },
    fetch: async (url, init) => {
      assert.equal(url, '/api/chat');
      const body = JSON.parse(init.body);
      calls.bodies.push(body);
      return body.model.startsWith('anthropic:') ? claudeChat(body, 'sk-ant-test') : other(body);
    },
    noteAllowance() {}, isTesterCode, isCapCode: () => false, modelLabel: (m) => m, toast: (msg) => calls.toasts.push(msg), navigator: { onLine: true },
    roleModels: (role) => (chains[role] || []).map((id) => [id, id]), modelReady: () => true, deadProviders: new Map(), PROVIDER_NAMES: {}, syncClip() {},
    // runChat
    EXT: { ready: true }, followUpRoute, threadTaint, ownTaint, FRESH_HINT: /\bnews|today\b/i, ABOUT_MEDIA: /$^/, ASKS_WEB: /$^/,
    providerReady: () => true, feat: () => true, wantsAgent: () => false, historyFor: () => [], needsBrains: () => false,
    modelFor: (role) => (chains[role] || ['nvidia:x'])[0], SYS: { ask: () => 'ask', code: () => 'code', web: () => 'web' }, repaint() {}, contextOf: () => null,
    // runAgent
    TOOLS: { services: { gmail: true } }, REMOTE: { online: false }, browserAvailable: () => false, agentTools: () => DEFS, claudeChats: 0,
    taintGates, taintNote, readsPage, pageOrigin, worseTaint, uid: (() => { let n = 0; return () => `u${++n}`; })(), persist() {}, scrollDown() {},
    awaitApproval: async (step) => { calls.approvals.push(step.name); return true; },
    callTool: async (name, args) => { calls.tools.push([name, args]); return { ok: true, result: [{ subject: 'Invoice' }] }; },
  };
  vars.ApiError = evalIn(vars, `return (${APP.slice(APP.indexOf('\nclass ApiError') + 1, APP.indexOf('\n}\n', APP.indexOf('\nclass ApiError')) + 2)});`);
  for (const n of CONSTS) vars[n] = evalIn(vars, `return (${constExpr(n)});`);
  for (const n of FNS) vars[n] = evalIn(vars, `return (${fnSource(n)});`);
  return { vars, calls };
}
const lastUser = (body) => body.messages.at(-1);

test('app: a Claude reply that only thought is nudged (effort low, EMPTY_NUDGE last) and its answer shows', async () => {
  const sent = anthropic(thinkOnly, () => claudeSSE([TH('short'), T('Here is the script.')], 'end_turn'));
  const { vars, calls } = rig({ chains: { code: ['anthropic:claude-opus-5-5', 'zai:glm-5.3'] } });
  const e = { kind: 'code', prompt: 'write a script', params: {} };
  await vars.runChat(e, null, { entries: [e] });
  assert.equal(e.text, 'Here is the script.');
  assert.match(e.think, /Planning the files/);
  assert.match(e.meta.note, /reasoning ran long — asking for the answer/);
  assert.doesNotMatch(e.meta.note, /length limit/, 'the nudged answer finished');
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[0].output_config, sent[1].output_config], [{ effort: 'high' }, { effort: 'low' }], 'Claude’s effort param takes the nudge’s low');
  assert.deepEqual(sent[1].messages.at(-1), { role: 'user', content: vars.EMPTY_NUDGE });
  assert.equal(sent[1].messages.filter((m) => m.role === 'assistant').length, 0, 'the thinking-only attempt is not replayed: a valid request');
  assert.deepEqual([sent[0].max_tokens, sent[1].max_tokens], [64000, 64000], 'the owner’s Code room for Claude');
  assert.deepEqual(calls.toasts, []);
});

test('app: Claude thinking-only twice → the next model answers; two empty models end as empty_answer', async () => {
  anthropic(thinkOnly);
  let r = rig({ chains: { code: ['anthropic:claude-opus-5-5', 'zai:glm-5.3', 'deepseek:deepseek-v4-pro'] } });
  const e = { kind: 'code', prompt: 'write a script', params: {} };
  await r.vars.runChat(e, null, { entries: [e] });
  assert.equal(e.meta.model, 'zai:glm-5.3');
  assert.equal(e.text, 'other');
  assert.deepEqual(r.calls.toasts, ['anthropic:claude-opus-5-5 gave no answer — switching']);
  assert.deepEqual(r.calls.bodies.map((b) => b.model), ['anthropic:claude-opus-5-5', 'anthropic:claude-opus-5-5', 'zai:glm-5.3']);
  // every model only thinks: two models at most, then the clear error
  anthropic(thinkOnly);
  r = rig({ chains: { code: ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'zai:glm-5.3'] } });
  const f = { kind: 'code', prompt: 'write a script', params: {} };
  await assert.rejects(r.vars.runChat(f, null, { entries: [f] }), (err) => err.code === 'empty_answer' && /only thought and never wrote an answer/.test(err.message));
  assert.equal(r.calls.bodies.length, 4, 'two models, each nudged once');
});

test('app: Claude cut at max_tokens → the length note in runChat (Ask, Code and Deep think)', async () => {
  for (const [kind, params, role] of [['ask', {}, 'ask'], ['code', {}, 'code'], ['ask', { think: true }, 'reason']]) {
    anthropic(() => claudeSSE([TH('…'), T('Step 1, step 2, ste')], 'max_tokens'));
    const { vars } = rig({ chains: { [role]: ['anthropic:claude-opus-5-5'] } });
    const e = { kind, prompt: 'explain', params };
    await vars.runChat(e, null, { entries: [e] });
    assert.equal(e.text, 'Step 1, step 2, ste');
    assert.match(e.meta.note, /hit the length limit — ask “continue” for the rest/, role);
  }
});

test('app: a Claude refusal shows its message — an error card when nothing came (no other provider tried), a note otherwise', async () => {
  const sent = anthropic(() => claudeSSE([], 'refusal', { details: { type: 'refusal', category: 'bio', explanation: '' } }));
  const { vars, calls } = rig({ chains: { ask: ['anthropic:claude-sonnet-5-5', 'openai:gpt-6-luna'] } });
  const e = { kind: 'ask', prompt: 'something', params: {} };
  await assert.rejects(vars.runChat(e, null, { entries: [e] }), (err) => err.status === 400 && err.code === 'refusal' && /safety checks flagged it/.test(err.message));
  assert.deepEqual([sent.length, calls.bodies.length, calls.toasts], [1, 1, []]);
  anthropic(() => claudeSSE([T('Some of it')], 'refusal'));
  const p = rig({ chains: { ask: ['anthropic:claude-sonnet-5-5'] } });
  const f = { kind: 'ask', prompt: 'something', params: {} };
  await p.vars.runChat(f, null, { entries: [f] });
  assert.equal(f.text, `Some of it\n\n_${STOPS.refusal.note}_`);
});

test('app: a paused web answer completes (the Worker continues it) and reads "live web", with no length note', async () => {
  const sent = anthropic(() => claudeSSE([SEARCH, RESULTS, T('Found it. ')], 'pause_turn'), () => claudeSSE([T('Headline A.')], 'end_turn'));
  const { vars } = rig({ chains: { web: ['anthropic:claude-sonnet-5-5'] } });
  const e = { kind: 'ask', prompt: 'what’s in the news today', params: { web: true } };
  await vars.runChat(e, null, { entries: [e] });
  assert.equal(e.text, 'Found it. Headline A.');
  assert.equal(e.meta.note, 'live web');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].max_tokens, 6000, 'web is a low-effort role: its budget is unchanged');
});

test('app (agent): a tool turn replays thinking + tool_use unchanged; max_tokens gives the length note; a call cut at the limit never runs', async () => {
  const sent = anthropic(
    () => claudeSSE([TH('need the inbox', 'sig-inbox'), USE('toolu_1', 'gmail_search', { q: 'is:unread' })], 'tool_use'),
    () => claudeSSE([T('You have an invoice email, and the deta')], 'max_tokens'));
  const { vars, calls } = rig({ chains: { agent: ['anthropic:claude-sonnet-5-5'] } });
  const e = { kind: 'ask', prompt: 'check my inbox', params: {} };
  await vars.runAgent(e, null, { entries: [e] });
  assert.deepEqual(calls.tools, [['gmail_search', { q: 'is:unread' }]]);
  assert.deepEqual(sent[1].messages.slice(-2).map((m) => m.role), ['assistant', 'user']);
  assert.deepEqual(sent[1].messages.at(-2).content, [{ type: 'thinking', thinking: 'need the inbox', signature: 'sig-inbox' }, { type: 'tool_use', id: 'toolu_1', name: 'gmail_search', input: { q: 'is:unread' } }], 'replayed verbatim');
  assert.equal(sent[1].messages.at(-1).content[0].tool_use_id, 'toolu_1');
  assert.match(e.text, /the deta\n\n_The answer hit the length limit and stopped here — ask “continue” for the rest._$/);
  // text, then a draft cut mid-call: the run ends with the note and the draft is never sent for approval
  anthropic(() => claudeSSE([T('Drafting it.'), USE('toolu_2', 'gmail_draft', {}, '{"body":"Dear Sam')], 'max_tokens'));
  const r = rig({ chains: { agent: ['anthropic:claude-sonnet-5-5'] } });
  const f = { kind: 'ask', prompt: 'draft a reply', params: {} };
  await r.vars.runAgent(f, null, { entries: [f] });
  assert.deepEqual([r.calls.tools, r.calls.approvals], [[], []]);
  assert.match(f.text, /^Drafting it\.\n\n_The answer hit the length limit/);
});

test('app (agent): a thinking-only turn is nudged; the nudged call replays without its thinking and without the nudge', async () => {
  const sent = anthropic(thinkOnly,
    () => claudeSSE([TH('fine, search', 'sig-nudged'), USE('toolu_5', 'gmail_search', { q: 'bank' })], 'tool_use'),
    () => claudeSSE([TH('summarise', 'sig-2'), T('Your bank wrote twice.')], 'end_turn'));
  const { vars, calls } = rig({ chains: { agent: ['anthropic:claude-sonnet-5-5'] } });
  const e = { kind: 'ask', prompt: 'any mail from my bank?', params: {} };
  await vars.runAgent(e, null, { entries: [e] });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1].messages.at(-1), { role: 'user', content: vars.EMPTY_NUDGE });
  assert.deepEqual(calls.tools, [['gmail_search', { q: 'bank' }]]);
  const turn2 = sent[2].messages;
  assert.equal(JSON.stringify(turn2).includes('wrote no answer'), false, 'the nudge is not in the history');
  assert.deepEqual(turn2.at(-2), { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_5', name: 'gmail_search', input: { q: 'bank' } }] }, 'thinking stripped');
  assert.equal(e.text, 'Your bank wrote twice.');
  assert.equal(sent[1].output_config.effort, 'low');
});

test('app (agent, Assist): once web search is withdrawn, earlier thinking goes back stripped; the tools change only then', async () => {
  const sent = anthropic(
    () => claudeSSE([TH('search the weather first', 'sig-w'), SEARCH, RESULTS, TH('now the inbox', 'sig-i'), USE('toolu_7', 'gmail_search', { q: 'flight' })], 'tool_use'),
    () => claudeSSE([TH('wrap up', 'sig-x'), T('Rain tomorrow; your flight is at 9.')], 'end_turn'));
  const { vars } = rig({ chains: { agent: ['anthropic:claude-sonnet-5-5'] } });
  const e = { kind: 'ask', prompt: 'weather tomorrow and my flight time', params: {}, via: 'assist' };
  await vars.runAgent(e, null, { entries: [e] });
  assert.ok(sent[0].tools.some((t) => t.type === 'web_search_20260209'));
  assert.ok(!sent[1].tools.some((t) => t.type === 'web_search_20260209'), 'withdrawn after an account read');
  const replay = sent[1].messages.at(-2);
  assert.deepEqual(replay.content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'tool_use'], 'no thinking bound to the old tools');
  assert.equal(e.text, 'Rain tomorrow; your flight is at 9.');
});

test('app: other providers keep their empty-answer rescue and length note (OpenAI, Gemini, DeepSeek, xAI)', async () => {
  for (const model of ['openai:gpt-6.1-sol', 'gemini:gemini-3.1-pro-preview', 'deepseek:deepseek-v4-pro', 'xai:grok-4.7']) {
    let n = 0;
    const other = () => (++n === 1 ? openaiSSE([{ delta: { reasoning_content: 'thinking…' } }, { finish: 'length' }])
      : openaiSSE([{ delta: { content: 'Answer.' } }, { finish: 'stop' }]));
    const { vars, calls } = rig({ chains: { code: [model] }, other });
    const e = { kind: 'code', prompt: 'write it', params: {} };
    await vars.runChat(e, null, { entries: [e] });
    assert.equal(e.text, 'Answer.', model);
    assert.match(e.meta.note, /reasoning ran long/);
    assert.deepEqual(calls.bodies.map((b) => [b.max_tokens, b.reasoning_effort]), [[6000, 'high'], [6000, 'low']], `${model}: budgets unchanged, nudge at low`);
    assert.equal(lastUser(calls.bodies[1]).content, vars.EMPTY_NUDGE);
    // cut with text: the note
    const cut = rig({ chains: { code: [model] }, other: () => openaiSSE([{ delta: { content: 'Half of it' } }, { finish: 'length' }]) });
    const f = { kind: 'code', prompt: 'write it', params: {} };
    await cut.vars.runChat(f, null, { entries: [f] });
    assert.match(f.meta.note, /hit the length limit/, model);
  }
  // whitespace is not an answer either
  let k = 0;
  const ws = rig({ chains: { ask: ['openai:gpt-6-luna'] }, other: () => (++k === 1 ? openaiSSE([{ delta: { content: '\n\n' } }, { finish: 'stop' }]) : openaiSSE([{ delta: { content: 'Real.' } }, { finish: 'stop' }])) });
  const g = { kind: 'ask', prompt: 'q', params: {} };
  await ws.vars.runChat(g, null, { entries: [g] });
  assert.equal(g.text, '\n\nReal.');
  // and an OpenAI agent turn cut mid-call doesn't run the call
  const ag = rig({ chains: { agent: ['openai:gpt-6-luna'] }, other: () => openaiSSE([{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'gmail_draft', arguments: '{"body":"Dea' } }] } }, { finish: 'length' }]) });
  const h = { kind: 'ask', prompt: 'draft', params: {} };
  await ag.vars.runAgent(h, null, { entries: [h] });
  assert.deepEqual(ag.calls.approvals, []);
  assert.match(h.text, /hit the length limit/);
});

test('app: Claude budgets — the owner’s high-effort roles get 64K, medium 16K, low keep theirs; testers and other providers unchanged', () => {
  const { vars } = rig();
  const room = (model, role, base) => vars.roomFor(model, role, base);
  assert.deepEqual(['code', 'reason', 'build'].map((r) => room('anthropic:claude-opus-5-5', r, 6000)), [64000, 64000, 64000]);
  assert.deepEqual(['agent', 'ideas', 'write'].map((r) => room('anthropic:claude-sonnet-5-5', r, 6000)), [16000, 16000, 16000]);
  assert.deepEqual(['ask', 'web', 'smart', 'vision', 'watch', 'fast'].map((r) => room('anthropic:claude-haiku-5-5', r, 900)), [900, 900, 900, 900, 900, 900]);
  assert.equal(room('anthropic:claude-opus-5-5', 'build', 32000), 64000);
  assert.equal(room('openai:gpt-6.1-sol', 'code', 6000), 6000);
  assert.equal(room('zai:glm-5.3', 'reason', 12000), 12000);
  vars.S.tester = { models: {} };
  assert.equal(room('anthropic:claude-opus-5-5', 'code', 6000), 6000, 'testers: the router prices the reservation from this figure');
  assert.match(APP, /max_tokens: think \? 12000 : 6000,/, 'runChat’s own figures (other providers, testers) are unchanged');
});

test('app: a tester’s Claude request keeps the caller’s max_tokens (the router prices it)', async () => {
  const sent = anthropic(() => claudeSSE([T('ok')], 'end_turn'));
  const { vars, calls } = rig({ chains: { code: ['anthropic:claude-sonnet-5-5'] }, tester: { models: {} } });
  const e = { kind: 'code', prompt: 'x', params: {} };
  await vars.runChat(e, null, { entries: [e] });
  assert.equal(calls.bodies[0].max_tokens, 6000);
  assert.equal(sent[0].max_tokens, 6000);
});

test('app: an answer declined partway stays on screen but is left out of later history, like a refusal before any text', async () => {
  const sent = anthropic(
    () => claudeSSE([TH('…'), T('PARTIAL steps one and two')], 'refusal', { details: { type: 'refusal', category: 'general_harms', explanation: '' }, model: 'claude-sonnet-5-5' }),
    () => claudeSSE([T('Sure.')], 'end_turn', { model: 'claude-sonnet-5-5' }));
  const { vars } = rig({ chains: { ask: ['anthropic:claude-sonnet-5-5'] } });
  vars.historyFor = (e, kinds, media, thread) => buildHistory(thread.entries.slice(0, thread.entries.indexOf(e)), { kinds, media });
  const e0 = { kind: 'ask', prompt: 'capital of France?', text: 'Paris.', meta: {} };
  const e1 = { kind: 'ask', prompt: 'first question', params: {} };
  const thread = { entries: [e0, e1] };
  await vars.runChat(e1, null, thread);
  assert.equal(e1.text, `PARTIAL steps one and two\n\n_${STOPS.refusal.note}_`, 'the partial and its note still show');
  assert.deepEqual([e1.refused, e1.error], [true, undefined]);
  const e2 = { kind: 'ask', prompt: 'unrelated follow-up', params: {} };
  thread.entries.push(e2);
  await vars.runChat(e2, null, thread);
  assert.deepEqual(sent[1].messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('')]),
    [['user', 'capital of France?'], ['assistant', 'Paris.'], ['user', 'unrelated follow-up']], 'the declined turn is gone; the earlier answer stays');
  assert.equal(e2.refused, undefined);
  // the accounts agent marks it too; a re-run clears the mark (run() resets it with the error)
  anthropic(() => claudeSSE([T('Part of the summary')], 'refusal'));
  const a = rig({ chains: { agent: ['anthropic:claude-sonnet-5-5'] } });
  const f = { kind: 'ask', prompt: 'summarise my inbox', params: {} };
  await a.vars.runAgent(f, null, { entries: [f] });
  assert.equal(f.refused, true);
  assert.match(APP, /\n {2}delete e\.refused;/);
  // buildHistory on its own: refused and failed turns alike are left out
  assert.deepEqual(buildHistory([e0, { kind: 'ask', prompt: 'q', text: 'half', refused: true }, { kind: 'ask', prompt: 'q2', text: 'x', error: 'Failed.' }]).length, 2);
});

test('app: the owner’s Claude ceilings count the fallback attempt and the rescue (the CLAUDE_ROOM comment’s figures)', async () => {
  const { vars } = rig();
  // one call, output only, at the room roomFor gives each role: the model plus its dearest server-side fallback attempt
  const usd = (model, role, base) => chatWorstCase({ model, inputTokens: 0, maxTokens: vars.roomFor(model, role, base), margin: false }) / 1e6;
  const call = {
    opus64: usd('anthropic:claude-opus-5-5', 'code', 6000), fable64: usd('anthropic:claude-fable-5-1', 'reason', 12000),
    sonnet64: usd('anthropic:claude-sonnet-5-5', 'build', 32000), opus16: usd('anthropic:claude-opus-5-5', 'write', 6000),
    sonnet16: usd('anthropic:claude-sonnet-5-5', 'ideas', 6000),
  };
  assert.deepEqual(call, { opus64: 2.88, fable64: 4.8, sonnet64: 1.28, opus16: 0.72, sonnet16: 0.32 });
  assert.equal(chatWorstCase({ model: 'anthropic:claude-opus-5-5', inputTokens: 0, maxTokens: 64000, margin: false, fallbacks: false }) / 1e6, 1.28, 'the report’s old figure left the fallback out');
  // one prompt: the first call and the nudge (same room) on each of at most two models
  const prompt = (a, b) => Math.round(2 * (a + b) * 100) / 100;
  assert.deepEqual([prompt(call.opus64, call.sonnet64), prompt(call.opus64, call.fable64), prompt(call.opus16, call.sonnet16)], [8.32, 15.36, 2.08]);
  const comment = APP.slice(APP.indexOf("// The owner's room for Claude"), APP.indexOf('\nconst CLAUDE_ROOM'));
  for (const fig of ['$2.88', '$4.80', '$1.28', '$0.72', '$0.32', '$8.32', '$15.36', '$2.08']) assert.ok(comment.includes(fig), fig);
  // the fallback attempt is real for the owner: Opus 5.5 and Fable 5.1 go out at 64K with fallbacks 'default'
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5']) {
    const sent = anthropic(() => claudeSSE([T('ok')], 'end_turn', { model }));
    await (await chat({ model: `anthropic:${model}`, max_tokens: 64000 })).text();
    assert.deepEqual([sent[0].max_tokens, sent[0].fallbacks], [64000, 'default'], model);
  }
});
