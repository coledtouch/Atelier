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

test('the legal pages keep the October 7, 2026 effective date for optional tester sync and feedback', () => {
  for (const page of [PRIVACY, TOS]) assert.match(page, /<p class="eyebrow">Effective October 7, 2026<\/p>/);
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
  // The ledger never stores prompt text; profile, opt-in synced threads, feedback and Look up are separate stores.
  assert.match(text(testers), /The ledger holds amounts and dates, not prompts or answers\./);
  assert.match(text(testers), /Server-stored profile and memory, optional synced threads, voluntary feedback and the Look up cache are described separately below\./);
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

test('owner thread sync is disclosed as it behaves: images and videos sync, media and long texts outlive a delete, the Wi-Fi rule, Clear this device keeps synced copies', async () => {
  const MERGE = await read('public/sync-merge.js'), SYNC = await read('public/sync.js');
  // what the wording below rests on: images and videos sync; strings over INLINE_MAX go to blobs; blobs are never
  // deleted (no compaction yet); a video over 10 MB waits for Wi-Fi on mobile data both ways unless the owner allows it
  assert.match(MERGE, /export const MEDIA_SYNC = Object\.freeze\(\{ image: true, video: true \}\);/, 'media sync changed: update the privacy wording');
  assert.match(MERGE, /inline: 32768, \/\/ strings longer than this/, 'the long-text threshold changed: update "about 32 KB"');
  assert.match(SYNC, /cellularMaxBytes: 10 \* 1024 \* 1024, \/\/ a video bigger than this waits for Wi-Fi on mobile data \/ Data Saver \(both ways\)/, 'the Wi-Fi rule changed: update "videos over 10 MB"');
  assert.match(SYNC, /cellular: 'Download videos on mobile data'/);
  assert.doesNotMatch(await read('src/sync.js'), /bucket\.delete\(blobKey|delete\(`b\//, 'blobs are deleted now: update "until a later clean-up"');
  assert.match(SYNC, /wipeConfirm: 'Clear Atelier threads[^']*synced threads stay on your Atelier server/);
  const items = [...PRIVACY.matchAll(/<li><b>The studio owner’s threads:?<\/b>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
  assert.equal(items.length, 2, 'the tester section and section 6');
  for (const it of items) {
    assert.doesNotMatch(it, /for now without|don’t sync|stay on the device where they were made/, 'no "media stays on the device" left');
    assert.match(it, /including their images and videos/);
    assert.match(it, /Tester sync uses a separate namespace and does not give testers access to the owner’s threads/);
  }
  assert.match(items[1], /The original of a video attached to a question isn’t synced \(only the frames and preview Atelier took from it are\)/);
  assert.match(items[1], /videos over 10 MB wait for Wi-Fi before they upload or download, unless the owner turns on “Download videos on mobile data”/);
  // the rule rests on navigator.connection, which Safari and Firefox don't have: there, videos sync on any network
  assert.match(SYNC, /connection: \(\) => navigator\.connection \|\| null/);
  assert.match(items[1], /On a phone whose browser reports mobile data or Data Saver \(Chrome on Android does; Safari on iPhone doesn’t, so there videos sync on any network\)/);
  assert.match(items[1], /except copies of images, videos and long texts \(over about 32 KB, such as long answers or pasted documents\), which remain in that private storage until a later clean-up removes the ones no thread uses/);
  const cache = text(/<li><b>Look-up cache \(Cloudflare\):<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.doesNotMatch(cache, /is the one exception|the only exception/);
  assert.match(cache, /stored separately from your profile and memory, optional synced threads and voluntary feedback/);
  const del = text(/<li><b>Delete conversations and media:<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.match(del, /Clear this device leaves synced copies in private cloud storage: delete synced threads from the Threads drawer instead/);
});

test('tester private sync disclosures match consent, account separation, quotas and the inactive-account purge', async () => {
  const [CLIENT, SERVER, LEDGER] = await Promise.all([read('public/sync.js'), read('src/tester/sync.js'), read('src/tester/ledger.js')]);
  // This Worker module also imports cloudflare: APIs. Read its constant as source, as with the OAuth scopes above.
  assert.match(SERVER, /export const TESTER_SYNC_QUOTA_BYTES = 1024 \*\* 3;/, 'update the disclosed 1 GiB cloud limit if it changes');
  assert.match(CLIENT, /const requireConsent = accountTester \|\| Boolean\(deps\.requireConsent\)/);
  assert.match(CLIENT, /if \(requireConsent\) \{ await askOwner\(\); return; \}/, 'a verified tester must still choose whether to sync');
  assert.match(CLIENT, /eng\.answer\(accountTester \? 'off' : 'new'\)/, 'closing tester consent leaves private sync off');
  assert.match(SERVER, /SYNC_BUCKET: c\.env\?\.SYNC_BUCKET \? await testerSyncBucket\(c\.env\.SYNC_BUCKET, c\.who\.sub\)/);
  assert.match(LEDGER, /RETAIN = 90 \* DAY/);
  assert.match(LEDGER, /await purgeTesterSync\(this\.#syncEnv, sub\);[\s\S]*?if \(result\.complete\) this\.#tx\(\(\) => this\.#forget\(sub\)\)/, 'purge cloud data before forgetting the tester record');
  assert.match(LEDGER, /tester cloud retention cleanup will retry/);
  const testers = text(/<h3 id="testers">([\s\S]*?)<\/ul>/.exec(PRIVACY)?.[1] || '');
  for (const words of ['off until you explicitly enable it', 'browser database for your LinkedIn account', 'private Cloudflare R2 storage namespace', '1 GiB cloud-storage limit', 'previous shared browser database stay local unless you explicitly select and import them']) assert.ok(testers.includes(words), words);
  const retention = text(/<li><b>Tester thread sync:<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  for (const words of ['off until you explicitly enable private sync', 'imported chats', 'Turning sync off in Settings → Your data stops new transfers but keeps existing cloud copies', 'Clear this device removes local data only', 'same LinkedIn account', 'restored for 30 days', '90 days of inactivity', 'retries it before deleting the tester record']) assert.ok(retention.includes(words), words);
  // What a tester's cloud storage keeps: no lifecycle rule or clean-up removes blobs, trash (x/) or history (v/) before the
  // 90-day purge, and the 1 GiB counts all of it (src/sync.js SYNC_COUNT_ALL), with at most 500 threads.
  const SYNC_CORE = await read('src/sync.js');
  assert.match(SERVER, /export const TESTER_SYNC_MAX_THREADS = 500;/, 'update the disclosed 500-thread limit');
  assert.match(SERVER, /SYNC_COUNT_ALL: true,/, 'the tester quota no longer counts everything: update "counts everything kept there"');
  assert.doesNotMatch(SYNC_CORE, /bucket\.delete\(blobKey|delete\(`b\/|delete\(`v\//, 'blobs or history are deleted now: update the tester retention wording');
  assert.doesNotMatch(retention, /until clean-up/, 'there is no clean-up before the 90-day purge');
  for (const words of ['1 GiB limit that counts everything kept there', 'up to 500 threads', 'Copies of images, videos and long texts (over about 32 KB) aren’t removed when a thread is deleted', 'until the entire tester cloud namespace is removed', 'are removed 30 days after they were saved']) assert.ok(retention.includes(words), words);
  // "removed 30 days after they were saved" rests on R2 lifecycle rules (30 days) on these two prefixes, which only hold
  // tester trash (x/) and history (v/): keep the mapping, or update the wording.
  assert.match(SERVER, /const split = \{ x: `testers-x\/\$\{hash\}\/`, v: `testers-v\/\$\{hash\}\/` \};/);
  assert.match(text(TOS), /1 GiB cloud-storage limit \(which also counts deleted threads’ saved copies and earlier versions\) and up to 500 threads/);
  const imported = text(/<li id="claude-chats">([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.match(imported, /imported threads sync to your other devices when thread sync is enabled/);
  assert.doesNotMatch(PRIVACY, /testers’ threads are never uploaded|a tester’s imported chats never leave the device/);
  assert.match(text(TOS), /Private thread sync is off until you explicitly enable it/);
  assert.match(text(TOS), /private tester cloud-sync namespace is purged before the expired record is deleted/);
});

test('voluntary feedback disclosures match the optional diagnostics, screenshot cap and storage expiry', async () => {
  const { FEEDBACK_LIMITS, cleanFeedbackDiagnostics } = await import('../src/feedback.js');
  assert.equal(FEEDBACK_LIMITS.screenshot, 350 * 1024);
  assert.equal(FEEDBACK_LIMITS.days, 90);
  assert.deepEqual(cleanFeedbackDiagnostics({ mode: 'ask', version: '76', online: true, viewport: { width: 393, height: 852 }, prompt: 'private text', account: { email: 'private@example.test' } }), { mode: 'ask', version: '76', online: true, viewport: { width: 393, height: 852 } });
  const source = await read('src/feedback.js');
  assert.match(source, /expirationTtl: FEEDBACK_LIMITS\.days \* 86400/, 'each submission expires independently of best-effort trimming');
  const submission = text(/<li id="feedback">([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  for (const words of ['if you choose Send feedback', 'studio owner', 'may choose to attach', 'under 350 KB', 'active mode, app version, online status and screen size', 'Prompts, conversation contents and private connected-account details are not automatically collected', 'Review your message and screenshot before submitting']) assert.ok(submission.includes(words), words);
  const retention = text(/<li><b>Voluntary feedback:<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  for (const words of ['up to 90 days after submission', 'expiry set when each submission is saved', 'Only the studio owner can read']) assert.ok(retention.includes(words), words);
  assert.match(text(TOS), /Feedback is voluntary/);
  assert.match(text(TOS), /submissions are kept for up to 90 days/);
});
