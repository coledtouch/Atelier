// review-nov03: an approval card showed any argument of 80 characters or less in a one-line <input>. On a phone the box
// clipped it, so a To of 'alex@company.com' + 40 spaces + ',evil@attacker.io' showed only the first address, and Approve
// sent both. Recipient fields (Gmail To, Cc and Bcc, calendar guests, a Slack channel) are now a wrapping box at any
// length with every address on its own line under it, and what the card shows is what Approve sends.
// renderSteps is lifted out of public/app.js and run against stubs, as tests/untrusted-turns.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8').then((s) => s.replace(/\r\n/g, '\n'));
const [APP, TOOLS_SRC] = await Promise.all(['public/app.js', 'src/tools.js'].map(read));

function fnSource(name) {
  const at = APP.indexOf(`\nfunction ${name}(`) + 1;
  assert.ok(at > 0, `app.js has function ${name}`);
  return APP.slice(at, APP.indexOf('\n}\n', at) + 2);
}
function constSource(name) {
  const at = APP.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `app.js has const ${name}`);
  return APP.slice(at + 1, APP.indexOf('\n', at + 1)).replace(new RegExp(`^const ${name} = `), '').replace(/;$/, '');
}
// The stubs are the module's variables; any other name not on globalThis is a no-op.
const scope = (vars) => new Proxy(vars, {
  has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
  get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined),
  set: (t, k, v) => { t[k] = v; return true; },
});
const evalIn = (vars, body) => new Function('scope', `with (scope) { ${body} }`)(scope(vars));

function rig(gmailAccounts = ['cole@x.com']) {
  const vars = { SERVICE_ICON: {}, taintNote: () => '', TOOLS: { services: { gmailAccounts } } };
  for (const name of ['esc', 'urlHost', 'BROWSER_READS', 'LONG_FIELDS', 'writesMail', 'RECIPIENTS', 'isRecipient', 'oneSpace', 'recipients', 'NAME_PARTS', 'toList']) vars[name] = evalIn(vars, `return (${constSource(name)});`);
  for (const name of ['mailFrom', 'renderSteps']) vars[name] = evalIn(vars, `return (${fnSource(name)});`);
  return vars;
}
const card = (name, args, v = rig()) => v.renderSteps({ steps: [{ id: 's1', status: 'awaiting', write: true, service: name.split('_')[0], name, label: name, args }] });
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// What the card shows for one argument: its box's text, and the text of each line of the list under it.
function shown(html, k) {
  const box = new RegExp(`<textarea data-arg="${k}" rows="\\d+">([^<]*)</textarea></label><ul class="ac-to">(.*?)</ul>`).exec(html);
  assert.ok(box, `${k}: a box with a list under it`);
  return { box: unescape(box[1]), lines: [...box[2].matchAll(/<li>(.*?)<\/li>/g)].map((m) => unescape(m[1].replace(/<\/?b>/g, ''))) };
}
const PAD = ' '.repeat(40);

test('recipient fields never render as a one-line input: a wrapping box, and a list under it with each address on a line', () => {
  const html = card('gmail_draft', { account: 'cole@x.com', to: `alex@company.com${PAD},evil@attacker.io`, cc: 'Alex Johnson <alex.johnson@companyname.com>, archive@evil.io', subject: 'Q3', body: 'Hi' });
  assert.doesNotMatch(html, /<input data-arg="(to|cc)"/);
  assert.match(html, /<textarea data-arg="to" rows="2">alex@company\.com ,evil@attacker\.io<\/textarea><\/label><ul class="ac-to"><li><b>alex@company\.com<\/b><\/li><li><b>evil@attacker\.io<\/b><\/li><\/ul>/);
  // the address in <angle brackets> is where it goes, so it's the bold part; the name before it is plain
  assert.match(html, /<ul class="ac-to"><li>Alex Johnson <b>&lt;alex\.johnson@companyname\.com&gt;<\/b><\/li><li><b>archive@evil\.io<\/b><\/li><\/ul>/);
  // the rest of the card is as it was: the mailbox it uses, short fields in one line, the body in a box
  assert.match(html, /<p class="ac-target">From: <b>cole@x\.com<\/b><\/p>/);
  assert.match(html, /<input data-arg="subject" value="Q3" \/>/);
  assert.match(html, /<textarea data-arg="body" rows="3">Hi<\/textarea>/);
  assert.equal(html.match(/<ul class="ac-to">/g).length, 2, 'a list under To and Cc only');
  // a card that's done shows no fields
  assert.doesNotMatch(rig().renderSteps({ steps: [{ id: 's2', status: 'done', service: 'gmail', name: 'gmail_draft', label: 'Save Gmail draft', args: { to: 'a@x.com' } }] }), /ac-to|textarea/);
});

test('every recipient field, at any length and as a list, gets the box and the list; an empty one shows no lines', () => {
  const v = rig();
  for (const k of ['to', 'cc', 'bcc', 'attendees', 'channel']) assert.ok(v.RECIPIENTS.has(k), k);
  for (const k of v.RECIPIENTS) {
    for (const val of ['', 'a@x.com', 'a@x.com,b@y.com', `a@x.com${PAD}${PAD},b@y.com`, 'x'.repeat(200), ['a@x.com', 'b@y.com'], ['a@x.com']]) {
      const html = card('gmail_send', { [k]: val }, v);
      assert.doesNotMatch(html, new RegExp(`<input data-arg="${k}"`), `${k}: ${JSON.stringify(val)}`);
      assert.match(html, new RegExp(`<textarea data-arg="${k}" rows="[2-6]">`), `${k}: ${JSON.stringify(val)}`);
    }
  }
  assert.match(card('gmail_send', { cc: '' }), /<textarea data-arg="cc" rows="2"><\/textarea><\/label><ul class="ac-to"><\/ul>/);
  // calendar guests (a list argument) and a Slack channel
  const cal = card('calendar_create', { title: 'Sync', start: '2026-11-04T10:00:00-06:00', end: '2026-11-04T10:30:00-06:00', attendees: ['amy@x.com', ` bob@y.com${PAD}`, 'eve@evil.io'] });
  assert.deepEqual(shown(cal, 'attendees'), { box: 'amy@x.com, bob@y.com , eve@evil.io', lines: ['amy@x.com', 'bob@y.com', 'eve@evil.io'] });
  assert.deepEqual(shown(card('slack_post', { channel: `${PAD}C0EVIL`, text: 'hi' }), 'channel'), { box: 'C0EVIL', lines: ['C0EVIL'] });
});

test('what the card shows is what Approve sends: the box reads back unchanged, and every address in it is on a line', () => {
  const v = rig();
  const cases = [
    `alex@company.com${PAD},evil@attacker.io`,
    'Alex Johnson <alex.johnson@companyname.com>, archive@evil.io',
    `alex@company.com\t\u00a0\u3000\u2028${PAD}evil@attacker.io`, // no comma: one line, both addresses on it
    '"Johnson, Alex" <alex@x.com>, b@y.com', // a comma inside a quoted name stays with its name
    '"alex@company.com" <evil@attacker.io>', // a name made to look like an address: the real one is the bold part
    'a@x.com, "unclosed, b@y.com', // an unclosed quote runs to the end of its line, so nothing drops out
    ',, a@x.com ,, b@y.com,',
    `${'x@y.com,'.repeat(30)}last@evil.io`,
    '"x\\" y" <evil@attacker.io>, "z" <alex@company.com>', // a \" doesn't close a quoted name
    '(") <evil@attacker.io>, (") Alex <alex@company.com>', // nor does a " inside a (comment) open one
    'a@x.com, "a <evil@attacker.io>, b <alex@company.com>', // an unclosed quote: its line runs to the end, all bold
  ];
  // the bold parts of the list under To: where each line goes
  const bold = (html) => [.../<ul class="ac-to">(.*?)<\/ul>/.exec(html)[1].matchAll(/<b>(.*?)<\/b>/g)].map((m) => unescape(m[1]));
  for (const to of cases) {
    const html = card('gmail_send', { to }, v);
    const { box, lines } = shown(html, 'to');
    assert.equal(v.oneSpace(box), box, `${JSON.stringify(to)}: the click handler's oneSpace leaves the box as shown`);
    assert.equal(box, v.oneSpace(to));
    assert.deepEqual(lines, v.recipients(box), 'the list is the box, split where Approve splits a list argument');
    for (const addr of box.match(/[^\s,<>"]+@[^\s,<>"]+/g)) assert.ok(lines.some((l) => l.includes(addr)), `${addr} is on a line`);
    // every <address> in the box is bold on some line, so a name never passes one off as plain text
    for (const [addr] of box.matchAll(/<[^<>]*@[^<>]*>/g)) assert.ok(bold(html).some((b) => b.includes(addr)), `${addr} is bold: ${JSON.stringify(to)}`);
    assert.doesNotMatch(lines.join('\n'), /^\s|\s$|\s{2}/m, 'no line starts, ends or pads with spaces');
  }
  assert.deepEqual(shown(card('gmail_send', { to: '"Johnson, Alex" <alex@x.com>, b@y.com' }, v), 'to').lines, ['"Johnson, Alex" <alex@x.com>', 'b@y.com']);
  assert.match(card('gmail_send', { to: '"alex@company.com" <evil@attacker.io>' }, v), /<li>&quot;alex@company\.com&quot; <b>&lt;evil@attacker\.io&gt;<\/b><\/li>/);
  // two mailboxes the v93 draft's split joined into one line: each on its own line now, its address in bold
  assert.deepEqual(shown(card('gmail_send', { to: '"x\\" y" <evil@attacker.io>, "z" <alex@company.com>' }, v), 'to').lines, ['"x\\" y" <evil@attacker.io>', '"z" <alex@company.com>']);
  assert.deepEqual(bold(card('gmail_send', { to: '(") <evil@attacker.io>, (") Alex <alex@company.com>' }, v)), ['<evil@attacker.io>', '<alex@company.com>']);
  // inside a closed quoted name, an address is only name text (Gmail sends to alex alone), so only alex is bold
  assert.deepEqual(bold(card('gmail_send', { to: '"a\\" b <evil@attacker.io>, c" <alex@company.com>' }, v)), ['<alex@company.com>']);
  // a name with an address mark outside its quotes may hide a mailbox: the whole line is bold
  assert.deepEqual(bold(card('gmail_send', { to: 'Alex evil@attacker.io <alex@company.com>' }, v)), ['Alex evil@attacker.io <alex@company.com>']);
  // markup in an address is text
  const bad = card('gmail_send', { to: '"<img src=x onerror=alert(1)>" <e@evil.io>, <b>x</b>@y.com' }, v);
  assert.doesNotMatch(bad, /<img|<b>x<\/b>/);
  assert.match(bad, /<li>&quot;&lt;img src=x onerror=alert\(1\)&gt;&quot; <b>&lt;e@evil\.io&gt;<\/b><\/li>/);
});

test('the approve click reads a recipient box back with oneSpace (a list argument split as its lines), and an edit redraws the list', () => {
  const handler = APP.slice(APP.indexOf("if (act === 'approve' || act === 'decline') {"), APP.indexOf('approvals.delete(st.id);\n    resolve('));
  assert.match(handler, /\$\$\(`\.approve-card\[data-step="\$\{st\.id\}"\] \[data-arg\]`, li\)\.forEach\(\(f\) => \{\n\s+const k = f\.dataset\.arg;\n\s+const orig = st\.args\[k\];\n\s+if \(isRecipient\(st, k\)\) \{ st\.args\[k\] = Array\.isArray\(orig\) \? recipients\(f\.value\) : oneSpace\(f\.value\); return; \}/);
  const v = rig();
  assert.deepEqual(v.recipients('amy@x.com, bob@y.com , eve@evil.io'), ['amy@x.com', 'bob@y.com', 'eve@evil.io'], 'attendees as their lines showed them');
  // the box is checked first, so a short recipient never reaches the one-line input below it
  const src = fnSource('renderSteps');
  assert.ok(src.indexOf('isRecipient(st, k)') > 0 && src.indexOf('isRecipient(st, k)') < src.indexOf('<input data-arg='), 'recipients before the one-line input');
  assert.match(APP, /\nconst isRecipient = \(st, k\) => Boolean\(st\.write\) && RECIPIENTS\.has\(k\);\n/, 'only a write’s arguments');
  assert.match(APP, /stream\.addEventListener\('input', \(ev\) => \{\n\s+const f = ev\.target, list = f\.closest\?\.\('\.approve-card label'\)\?\.nextElementSibling;\n\s+if \(RECIPIENTS\.has\(f\.dataset\?\.arg\) && list\?\.classList\.contains\('ac-to'\)\) list\.innerHTML = toList\(f\.value\);/);
});

test('a read’s `to` is no recipient: calendar_list’s end date and claude_history_read’s last turn stay one-line fields', () => {
  const v = rig();
  const read = (name, args) => v.renderSteps({ steps: [{ id: 'r1', status: 'awaiting', write: false, service: name.split('_')[0], name, label: name, args }] });
  for (const html of [read('calendar_list', { from: '2026-11-03T00:00:00Z', to: '2026-11-10T00:00:00Z' }), read('claude_history_read', { id: 'claude-1', from: 1, to: 12 })]) {
    assert.match(html, /<input data-arg="to" value="[^"]+" \/>/);
    assert.doesNotMatch(html, /ac-to|<textarea data-arg="to"/);
  }
});

test('every tool argument in src/tools.js that names who or where it reaches is a recipient field', () => {
  const v = rig();
  const keys = [...TOOLS_SRC.matchAll(/(\w+): (?:S\('(?:Recipient|Cc|Bcc|Channel id|Guest)[^']*'\)|\{ type: 'array', items: \{ type: 'string' \}, description: 'Guest emails)/g)].map((m) => m[1]);
  for (const k of ['to', 'cc', 'attendees', 'channel']) assert.ok(keys.includes(k), `${k}: src/tools.js still names it so`);
  for (const k of keys) assert.ok(v.RECIPIENTS.has(k), k);
});

test('app.css lists each recipient on its own line, wrapping a long one, and hides an empty list', async () => {
  const css = await read('public/app.css');
  const rule = /\n\.ac-to \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /list-style: none/);
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.doesNotMatch(rule, /max-height|overflow: hidden|white-space: nowrap|text-overflow/, 'nothing in the list is ever clipped');
  assert.match(css, /\n\.ac-to:empty \{ display: none; \}/);
  // the box keeps the phone's 16px rule (iOS zooms a focused control under 16px)
  assert.match(await read('public/studio.css'), /\.ac-fields textarea[^{]*\{ font-size: 16px; \}/);
});

// The review fixture (scripts/review-server.mjs --providers) offers a stub gmail_draft, flagged as a write the way the
// Worker's /api/tools flags one, and "draft fixture" makes the accounts agent call it with the padded To.
test('review fixture: "email draft fixture" shows a Gmail draft card with the padded To; the stub saves nothing unless approved', async () => {
  const [{ spawn }, { createServer }, { fileURLToPath }] = await Promise.all([import('node:child_process'), import('node:net'), import('node:url')]);
  const port = await new Promise((res, rej) => { const s = createServer().once('error', rej).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const child = spawn(process.execPath, ['scripts/review-server.mjs', '--providers'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, REVIEW_TESTER: '', REVIEW_PORT: String(port), REVIEW_SYNC: '', REVIEW_BREAK: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let timer, out = '';
  try {
    await new Promise((res, rej) => {
      timer = setTimeout(() => rej(new Error('the review fixture didn’t start')), 15_000);
      child.stdout.on('data', (d) => { out += d; if (/Isolated review/.test(out)) res(); });
      child.once('exit', (code) => rej(new Error(`the review fixture exited (${code})`)));
    });
    const base = `http://127.0.0.1:${port}/api/`, own = { 'content-type': 'application/json', 'x-app-pass': 'review-only' };
    const { services, list } = await (await fetch(base + 'tools', { headers: own })).json();
    assert.deepEqual(services, { gmail: true }, 'no mailbox listed, as before');
    assert.deepEqual(list.map((t) => [t.function.name, t['x-write'], t['x-label'], t['x-service']]), [['gmail_search', false, 'Search Gmail', 'gmail'], ['gmail_draft', true, 'Save Gmail draft', 'gmail']]);
    const run = (b, headers = own) => fetch(base + 'tools/run', { method: 'POST', headers, body: JSON.stringify(b) });
    const args = { to: 'a@x.com', subject: 'Q3', body: 'Hi' };
    for (const approved of [undefined, false, 'true', 1]) assert.deepEqual(await (await run({ name: 'gmail_draft', args, approved })).json(), { ok: false, error: 'This action needs the user\'s approval in the app.' }, String(approved));
    assert.equal((await run({ name: 'gmail_draft', args, approved: true }, { 'content-type': 'application/json' })).status, 401, 'no passcode');
    assert.deepEqual(await (await run({ name: 'gmail_draft', args, approved: true })).json(), { ok: true, result: { saved: true, draftId: 'fixture' } });
    const logged = /gmail_draft \(fixture, nothing saved\) \{"to":"a@x\.com","cc":null\}/;
    for (let i = 0; i < 40 && !logged.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, logged, 'it prints the To and Cc it got');
    assert.equal((await (await run({ name: 'gmail_search', args: { q: 'x' } })).json()).result.messages.length, 1, 'gmail_search as before');
    // the accounts agent's turns
    const chat = async (messages) => (await (await fetch(base + 'chat', { method: 'POST', headers: own, body: JSON.stringify({ model: 'openai:gpt-fixture', messages, tools: list.map(({ type, function: f }) => ({ type, function: f })) }) })).text())
      .split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const call = (events) => events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls || [])[0]?.function;
    const said = (events) => events.map((e) => e.choices?.[0]?.delta?.content || '').join('');
    const user = { role: 'user', content: 'email draft fixture' };
    const drafted = call(await chat([{ role: 'system', content: 'agent' }, user]));
    assert.equal(drafted.name, 'gmail_draft');
    assert.deepEqual(JSON.parse(drafted.arguments), { to: `alex@company.com${PAD},evil@attacker.io`, cc: 'Alex Johnson <alex.johnson@companyname.com>, archive@evil.io', subject: 'Q3 numbers (local fixture)', body: 'Hi Alex,\n\nHere are the Q3 numbers. This is a local fixture, so nothing is sent.\n\nCole' });
    const after = (content) => chat([user, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: drafted }] }, { role: 'tool', tool_call_id: 'c1', content }]);
    assert.match(said(await after('{"saved":true,"draftId":"fixture"}')), /^Draft saved\./);
    assert.match(said(await after('{"error":"The user declined this action."}')), /^OK, no draft saved\./);
    // an inbox question still searches
    assert.equal(call(await chat([{ role: 'user', content: 'check my inbox' }])).name, 'gmail_search');
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
