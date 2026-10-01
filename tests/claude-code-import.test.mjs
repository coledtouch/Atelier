// The Claude Code import (public/app.js readClaudeCode) sends the analysis model the user's own prompts plus a list of
// the projects they worked in. Only each project's own folder name may go: never a drive letter, the parent folders or
// a home folder (whose name is the computer's user name). privacy.html §2 says so; these tests hold the code to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const APP = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const PRIVACY = await readFile(new URL('../public/privacy.html', import.meta.url), 'utf8');
const INDEX = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

// app.js is a browser script (it touches the DOM at load), so the two functions are lifted out of its source.
function lift(name, isAsync = false) {
  const m = new RegExp(`${isAsync ? 'async ' : ''}function ${name}\\([\\s\\S]*?\\r?\\n\\}\\r?\\n`).exec(APP);
  assert.ok(m, `app.js defines ${name}`);
  return m[0];
}
const claudeCodeFolder = new Function(`${lift('claudeCodeFolder')}\nreturn claudeCodeFolder;`)();
const statuses = [];
const readClaudeCode = new Function('impStatus', `${lift('claudeCodeFolder')}\n${lift('readClaudeCode', true)}\nreturn readClaudeCode;`)((s) => statuses.push(s));

// A File System Access directory handle, enough for readClaudeCode's walk.
const file = (name, lines, lastModified = 1_000) => ({ kind: 'file', name, getFile: async () => ({ lastModified, text: async () => lines.map((l) => JSON.stringify(l)).join('\n') }) });
const dir = (name, entries) => ({ kind: 'directory', name, async *values() { yield* entries; } });
const prompt = (cwd, text, extra = {}) => ({ type: 'user', cwd, timestamp: '2026-09-30T12:00:00Z', message: { role: 'user', content: text }, ...extra });

test('claudeCodeFolder keeps only the last folder name of a project path', () => {
  const cases = [
    ['C:\\Users\\jane.doe\\Clients\\Acme-Merger\\due-diligence', 'due-diligence'],
    ['C:\\Users\\cole\\OneDrive\\Desktop\\Assistant', 'Assistant'],
    ['C:\\Users\\cole\\OneDrive\\Desktop\\Assistant\\', 'Assistant'],
    ['/Users/jane/code/atelier', 'atelier'],
    ['/home/jane/src/my app', 'my app'],
    ['\\\\fileserver\\share\\Team Site', 'Team Site'],
    ['D:/work//site/', 'site'],
    ['/mnt/c/Users/jane/projects/web', 'web'],
  ];
  for (const [cwd, want] of cases) assert.equal(claudeCodeFolder(cwd), want, cwd);
});

test('claudeCodeFolder leaves out home folders (the user name), drive roots and junk', () => {
  for (const cwd of ['C:\\Users\\jane.doe', 'C:\\Users\\jane.doe\\', '/Users/jane', '/home/jane', '/mnt/c/Users/jane', 'c:\\users\\JANE',
    'C:\\', 'D:', '/', '/mnt/c', '', '   ', null, undefined, {}, 42]) {
    assert.equal(claudeCodeFolder(cwd), '', String(cwd));
  }
  assert.equal(claudeCodeFolder(`/srv/${'x'.repeat(200)}`).length, 80, 'a very long name is cut');
});

test('readClaudeCode sends folder names and prompt counts, never a full path, drive or user name', async () => {
  const root = dir('projects', [
    dir('C--Users-jane-doe-Clients-Acme', [file('a.jsonl', [
      prompt('C:\\Users\\jane.doe\\Clients\\Acme', 'Draft the merger memo'),
      prompt('C:\\Users\\jane.doe\\Clients\\Acme', 'Tighten section 2'),
      prompt('C:\\Users\\jane.doe\\Clients\\Acme', 'not mine', { isMeta: true }),
      { type: 'assistant', cwd: 'C:\\Users\\jane.doe\\Clients\\Acme', message: { role: 'assistant', content: 'Sure' } },
    ])]),
    dir('C--Users-jane-doe', [file('b.jsonl', [prompt('C:\\Users\\jane.doe', 'Clean up my downloads')])]),
    dir('two-sites', [file('c.jsonl', [prompt('/home/jane/a/site', 'Fix the header'), prompt('D:\\b\\site', 'Fix the footer')])]),
  ]);
  const { items, extra } = await readClaudeCode(root, 0);
  assert.deepEqual(items.map((i) => i.text), ['Draft the merger memo', 'Tighten section 2', 'Clean up my downloads', 'Fix the header', 'Fix the footer']);
  assert.equal(extra, 'Projects they work on in Claude Code (folder names only):\nAcme (2 prompts)\nsite (2 prompts)');
  for (const leak of ['jane', 'Users', 'Clients', 'C:', 'D:', '\\', '/home']) assert.ok(!extra.includes(leak), `no "${leak}" in ${JSON.stringify(extra)}`);
});

test('readClaudeCode sends no project list when every session ran in a home folder or drive root', async () => {
  const root = dir('projects', [file('a.jsonl', [prompt('C:\\Users\\jane', 'hello'), prompt('E:\\', 'hi')])]);
  const { items, extra } = await readClaudeCode(root, 0);
  assert.equal(items.length, 2);
  assert.equal(extra, '');
});

test('app.js keys the project list on the folder name; the privacy page describes exactly that', () => {
  assert.match(APP, /const folder = j\.cwd \? claudeCodeFolder\(j\.cwd\) : '';\s*if \(folder\) projects\.set\(folder,/);
  assert.doesNotMatch(APP, /projects\.set\(j\.cwd/);
  assert.doesNotMatch(APP, /Claude Code \(working directories\)/);
  const imported = PRIVACY.match(/<li><b>Imported history<\/b>([\s\S]*?)<\/li>/);
  assert.ok(imported, 'the Imported history item');
  assert.match(imported[1], /the last folder name of up to 25 projects/);
  assert.match(imported[1], /how many prompts each had/);
  assert.match(imported[1], /never the drive, the folders above it or your home folder/);
});

test('the Import your history hint says what a Claude Code import sends besides your own messages', () => {
  const hint = INDEX.match(/<h4>Import your history<\/h4>\s*<p class="hint">([\s\S]*?)<\/p>/);
  assert.ok(hint, 'the Import your history hint');
  assert.match(hint[1], /only your own messages \(and, for Claude Code, your project folder names and prompt counts\) are sent to an AI model/);
});
