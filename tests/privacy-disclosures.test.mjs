// The privacy page and terms must name what the code actually asks for and loads: every Google and Canva OAuth scope
// (src/tools.js; one consent asks for all of them) and the Cloudflare Web Analytics beacon the edge injects (allowed by
// public/_headers' CSP), the Google Fonts every page loads, and the Look-up cache (src/lookup.js). A new scope, beacon
// or third-party load without a disclosure fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const [TOOLS, PRIVACY, TOS, HEADERS] = await Promise.all([read('src/tools.js'), read('public/privacy.html'), read('public/tos.html'), read('public/_headers')]);
// The page's own text: tags dropped, entities left alone (the copy uses literal characters).
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// src/tools.js imports cloudflare: modules, so the scope lists are read from its source.
function googleScopes() {
  const block = /export const GOOGLE_SCOPES = \[([\s\S]*?)\]\.join\(' '\);/.exec(TOOLS);
  assert.ok(block, 'src/tools.js GOOGLE_SCOPES');
  return [...block[1].matchAll(/'https:\/\/www\.googleapis\.com\/auth\/([^']+)'/g)].map((m) => m[1]);
}
function canvaScopes() {
  const block = /export const CANVA_SCOPES = \[([^\]]*)\]\.join\(' '\);/.exec(TOOLS);
  assert.ok(block, 'src/tools.js CANVA_SCOPES');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the Google section lists every scope the consent screen asks for, each with what Atelier does with it', () => {
  const scopes = googleScopes();
  assert.equal(scopes.length, 8, 'eight Google scopes today: update the privacy table with any change');
  const section = /<h2 id="google">([\s\S]*?)<h2>/.exec(PRIVACY)?.[1];
  assert.ok(section, 'the #google section');
  assert.match(section, /Gmail, Calendar, Drive and Photos/);
  assert.match(section, /<code>https:\/\/www\.googleapis\.com\/auth\/<\/code>/, 'says how a short name maps to the full scope');
  // <wbr> lets a long scope name wrap at its dots on a phone.
  const rows = new Map([...section.replace(/<wbr>/g, '').matchAll(/<tr><td><code>([^<]+)<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual([...rows.keys()].sort(), [...scopes].sort(), 'one row per scope, no more, no less');
  for (const [scope, what] of rows) assert.ok(text(what).trim().length > 40, `${scope}: says in plain words what it is for`);
  for (const s of ['gmail.send', 'calendar.events', 'drive.file']) assert.match(rows.get(s), /only after you (review and )?approve it/, `${s} acts only on approval`);
  assert.match(section, /Only the owner can connect a Google account; testers never can\./);
  assert.match(PRIVACY, /<meta name="description" content="[^"]*Google APIs \(Gmail, Calendar, Drive and Photos\)/);
});

test('Canva and its scopes are disclosed, and the terms name Google and Canva', () => {
  const canva = /<li><b>Canva<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1];
  assert.ok(canva, 'a Canva item under Connected accounts');
  for (const s of canvaScopes()) assert.ok(canva.includes(`<code>${s}</code>`), `Canva scope ${s}`);
  assert.match(PRIVACY, /<tr><td>Google \(Gmail, Calendar, Drive, Photos\), Canva, Slack, GitHub, Stripe, Cloudflare, Railway<\/td>/);
  assert.match(PRIVACY, /<b>Disconnect Canva:<\/b>/);
  assert.match(TOS, /works with your Google \(Gmail, Calendar, Drive and Photos\), Canva, Slack, GitHub, Stripe, Cloudflare and Railway accounts/);
  assert.match(TOS, /Testers cannot connect accounts \(such as Google, Canva or Slack\)/);
});

test('Cloudflare Web Analytics is disclosed whenever the CSP lets its beacon run, and nothing says "no analytics"', () => {
  assert.ok(HEADERS.includes('https://static.cloudflareinsights.com'), 'the CSP still allows the beacon (else drop this disclosure too)');
  const item = /<li><b>Page analytics<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1];
  assert.ok(item, 'a Page analytics item under Technical data');
  for (const words of ['Cloudflare Web Analytics', 'static.cloudflareinsights.com', 'no cookies', 'does not fingerprint', 'referred you',
    'your country', 'browser', 'device type', 'aggregate', 'switch it off']) assert.ok(text(item).includes(words), words);
  assert.doesNotMatch(PRIVACY, /do not use analytics/i);
  assert.match(PRIVACY, /<tr><td>Cloudflare<\/td><td>[^<]*Cloudflare Web Analytics/);
  assert.match(PRIVACY, /<h3 id="technical">Technical data<\/h3>/);
  assert.match(PRIVACY, /<b>In short:<\/b>[^<]*cookieless page-view counts/);
});

test('the legal pages keep the October 1, 2026 effective date', () => {
  for (const page of [PRIVACY, TOS]) assert.match(page, /<p class="eyebrow">Effective October 1, 2026<\/p>/);
});

test('Google Fonts is disclosed while any page loads it: in Technical data, as a processor and in the short summary', async () => {
  const pages = await Promise.all(['public/index.html', 'public/privacy.html', 'public/tos.html'].map(read));
  const loads = pages.some((p) => /<link [^>]*href="https:\/\/fonts\.googleapis\.com\/css2/.test(p));
  assert.ok(loads, 'the pages still load Google Fonts (else drop this disclosure too)');
  assert.ok(HEADERS.includes('https://fonts.googleapis.com') && HEADERS.includes('https://fonts.gstatic.com'), 'the CSP allows both Google Fonts hosts');
  const item = /<li><b>Fonts<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1];
  assert.ok(item, 'a Fonts item under Technical data');
  assert.ok(PRIVACY.indexOf('<h3 id="technical">') < PRIVACY.indexOf('<li><b>Fonts</b>'), 'inside Technical data');
  for (const words of ['Google Fonts', 'fonts.googleapis.com', 'fonts.gstatic.com', 'directly from Google', 'IP address', 'browser details', 'no cookies', 'jsDelivr', 'unpkg'])
    assert.ok(text(item).includes(words), words);
  assert.match(PRIVACY, /<tr><td>Google Fonts<\/td><td>[^<]*directly from Google/);
  assert.match(PRIVACY, /<b>In short:<\/b>[^<]*web-font downloads/);
});

test('the Look-up cache is disclosed with the lifetimes src/lookup.js gives it, and the tester section no longer says nothing is stored', async () => {
  const LOOKUP = await read('src/lookup.js');
  const found = Number(/ttlFound: (\d+)/.exec(LOOKUP)?.[1]), miss = Number(/ttlMiss: (\d+)/.exec(LOOKUP)?.[1]), image = Number(/ttl: (\d+), \/\/ edge cache/.exec(LOOKUP)?.[1]);
  assert.deepEqual([found, miss, image], [86_400, 3_600, 604_800], 'update the privacy wording with any change');
  assert.match(LOOKUP, /JSON\.stringify\(\[String\(who \?\? ''\), site\.lang, site\.acceptLanguage \|\| '', mode, String\(norm\)\]\)/, 'the summary key hashes who asked and the phrase');
  assert.match(LOOKUP, /JSON\.stringify\(\[String\(who \?\? ''\), key\]\)/, 'the image key hashes who asked and the file');
  const cache = /<li><b>Look-up cache \(Cloudflare\):<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1];
  assert.ok(cache, 'a Look-up cache item in section 6');
  for (const words of ['up to 24 hours', '1 hour when Wikipedia has no article', 'up to 7 days', 'repeats the phrase you selected', 'who asked', 'SHA-256', 'edge cache', 'only ever served back to the same person'])
    assert.ok(text(cache).includes(words), words);
  const testers = /<h3 id="testers">([\s\S]*?)<\/ul>/.exec(PRIVACY)?.[1];
  assert.ok(testers, 'the tester section');
  assert.doesNotMatch(testers, /No prompts or outputs are stored on our servers\.<\/b>/, 'no unqualified promise');
  // Not only Look up: learned facts (learnFrom → PUT /api/tester/profile) are model output kept on the server too.
  assert.match(text(testers), /No prompts or outputs are stored on our servers , except your profile and memory \(next item, including facts Atelier notes from your conversations\) and a Look up answer, which repeats the few words you selected and is cached for up to a day \(see “Look-up cache” in section 6\)\./);
  assert.match(text(/<li><b>Look up<\/b> — free([\s\S]*?)<\/li>/.exec(testers)?.[1] || ''), /cached briefly at Cloudflare for you alone/);
  // The addendum records it as an exception to spec §10, next to the profile and memory (A6) — not the only one.
  const a83 = /### A8\.3([\s\S]*?)\n### /.exec(await read('docs/superpowers/specs/2026-09-30-atelier-tester-access-addendum.md'))?.[1] || '';
  for (const words of ['`caches.default`', '24 h', '1 h', '7 days', '`t:<sub>`', 'an exception to spec §10', 'profile and memory']) assert.ok(a83.includes(words), `A8.3: ${words}`);
  assert.ok(!a83.includes('one exception'), 'A8.3: not "the one exception"');
});

test('Quick launch’s on-device storage is disclosed with the lifetimes public/launch.js gives it, and dictation covers a mic Atelier opens', async () => {
  const { SHARE_TTL, DRAFT_TTL, PENDING_TTL, SHARE_CACHE, LAUNCH_STORE_KEYS } = await import('../public/launch.js');
  assert.deepEqual([SHARE_TTL, DRAFT_TTL, PENDING_TTL].map((ms) => ms / 60e3), [30, 360, 15], 'update the privacy wording with any change');
  assert.equal(SHARE_CACHE, 'atelier-share');
  for (const k of ['draft', 'pendingLaunch', 'quick', 'launchKey']) assert.ok(LAUNCH_STORE_KEYS.includes(k), `${k} is one of the keys sign-out forgets`);
  const s6 = /<h2>6\. Where data is stored and for how long<\/h2>([\s\S]*?)<h2>/.exec(PRIVACY)?.[1] || '';
  const item = /<li><b>Quick launch \(this device only\):<\/b>([\s\S]*?)<\/li>/.exec(s6)?.[1];
  assert.ok(item, 'a Quick launch item in section 6');
  // The limits are checked on read (freshMeta, takeDraft, peekPendingLaunch), not timers: say when things are deleted.
  for (const words of ['share to Atelier', 'a website sends to it the same way', 'Cache Storage', 'can be used for 30 minutes', 'checked when Atelier reads it, not by a timer',
    'one video or 4 photos', 'deleted once opened, the next time Atelier opens after that', 'when you sign out', 'Clear this device', 'typed or dictated',
    'can come back for 6 hours', 'can continue for 15 minutes after you sign in', 'deleted when you next sign in or open Atelier signed in',
    'Quick launch choices', 'Send without a tap', 'the key never does',
    // the Shortcut's link (key + words) lands in browser History; a share with no service worker reaches the Worker
    'History (and History sync', 'keeps the key and those words', 'New link',
    'sent by your browser to Atelier’s server instead', 'discards it without reading or storing it'])
    assert.ok(text(item).includes(words), words);
  for (const gone of ['up to 30 minutes', 'up to 6 hours', 'up to 15 minutes']) assert.ok(!text(item).includes(gone), `no "${gone}": nothing deletes on a timer`);
  // The mic can open without a tap (Talk to Atelier, listen-on-open): both dictation descriptions say so.
  const voice = /<li><b>Voice dictation<\/b> — on an iPhone([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '';
  assert.match(text(voice), /whether you tap it, or Talk to Atelier or “Start listening when I open Atelier” opens it for you/);
  const row = /<tr><td>OpenAI and Google \(dictation\)<\/td><td>([\s\S]*?)<\/td><\/tr>/.exec(PRIVACY)?.[1] || '';
  assert.doesNotMatch(row, /^When you tap the microphone/, 'not only a tap');
  assert.match(text(row), /Talk to Atelier or “Start listening when I open Atelier” opens the microphone for you/);
});

test('owner thread sync is disclosed as v1 behaves: media stays on the device, long texts can outlive a delete, Clear this device keeps synced copies', async () => {
  const MERGE = await read('public/sync-merge.js'), SYNC = await read('public/sync.js');
  // what the wording below rests on: phase 1 keeps images and videos on the device; strings over INLINE_MAX go to blobs
  assert.match(MERGE, /export const MEDIA_SYNC = Object\.freeze\(\{ image: false, video: false \}\);/, 'media sync turned on: update the privacy wording');
  assert.match(MERGE, /inline: 32768, \/\/ strings longer than this/, 'the long-text threshold changed: update "about 32 KB"');
  assert.match(SYNC, /wipeConfirm: 'Clear Atelier threads[^']*synced threads stay on your Atelier server/);
  const items = [...PRIVACY.matchAll(/<li><b>The studio owner’s threads:?<\/b>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
  assert.equal(items.length, 2, 'the tester section and section 6');
  for (const it of items) {
    assert.doesNotMatch(it, /including generated media/);
    assert.match(it, /images and videos/);
    assert.match(it, /LinkedIn testers’ threads are never uploaded/);
  }
  assert.match(items[1], /except copies of long texts \(over about 32 KB, such as long answers or pasted documents\)/);
  const cache = text(/<li><b>Look-up cache \(Cloudflare\):<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.doesNotMatch(cache, /is the one exception|the only exception/);
  assert.match(cache, /Together with your profile and memory \(section 2\) and the studio owner’s own synced threads \(see above\), it is an exception/);
  const del = text(/<li><b>Delete conversations and media:<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.match(del, /Clear this device leaves the synced copies on the owner’s server: delete synced threads from the Threads drawer instead/);
});
