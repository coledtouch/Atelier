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
  assert.match(TOS, /work with accounts you connect: Google \(Gmail, Calendar, Drive and Photos\), Canva and Slack\. It can also work with GitHub, Stripe, Cloudflare and Railway/);
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
  assert.match(PRIVACY, /<b>At a glance:<\/b>[^<]*cookieless page-view counts/);
});

test('the legal pages carry the October 11, 2026 effective date (passcode Guard cookie, testers reopened, humanizer rewrite)', () => {
  for (const page of [PRIVACY, TOS]) assert.match(page, /<p class="eyebrow">Effective October 11, 2026<\/p>/);
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
  assert.match(PRIVACY, /<b>At a glance:<\/b>[^<]*web-font downloads/);
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
  assert.match(text(testers), /Usage ledger — for each request, how much it cost and when\. It lets Atelier enforce your daily and monthly allowance\. The ledger doesn’t hold prompts or answers\./);
  assert.match(text(testers), /Other stores are described separately below\. They are server-stored profile and memory, optional synced threads, voluntary feedback and the Look up cache\./);
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
  for (const words of ['share to Atelier', 'a website sends to it the same way', 'Cache Storage', 'can be used for 30 minutes', 'That limit is checked when Atelier reads it. Nothing deletes it on a timer.',
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
  assert.match(text(voice), /The mic may open from your tap\. Talk to Atelier can also open it for you\. So can “Start listening when I open Atelier”\./);
  const row = /<tr><td>OpenAI and Google \(dictation\)<\/td><td>([\s\S]*?)<\/td><\/tr>/.exec(PRIVACY)?.[1] || '';
  assert.doesNotMatch(row, /^When you tap the microphone/, 'not only a tap');
  assert.match(text(row), /That includes when Talk to Atelier opens the microphone for you\. It also includes when “Start listening when I open Atelier” opens it\./);
});

test('owner thread sync is disclosed as it behaves: images and videos sync, media and long texts outlive a delete, the Wi-Fi rule, Clear this device keeps synced copies', async () => {
  const MERGE = await read('public/sync-merge.js'), SYNC = await read('public/sync.js');
  // what the wording below rests on: images and videos sync; strings over INLINE_MAX go to blobs; blobs are never
  // deleted (no compaction yet); a video over 10 MB waits for Wi-Fi on mobile data both ways unless the owner allows it
  assert.match(MERGE, /export const MEDIA_SYNC = Object\.freeze\(\{ image: true, video: true \}\);/, 'media sync changed: update the privacy wording');
  assert.match(MERGE, /inline: 32768, \/\/ strings longer than this/, 'the long-text threshold changed: update "about 32 KB"');
  assert.match(SYNC, /cellularMaxBytes: 10 \* 1024 \* 1024, \/\/ a video bigger than this waits for Wi-Fi on mobile data \/ Data Saver \(both ways\)/, 'the Wi-Fi rule changed: update "videos over 10 MB"');
  assert.match(SYNC, /cellular: 'Download videos on mobile data'/);
  assert.doesNotMatch(await read('src/sync.js'), /bucket\.delete\(blobKey|delete\(`b\//, 'blobs are deleted now: update "not removed automatically"');
  assert.match(SYNC, /wipeConfirm: 'Clear Atelier threads[^']*synced threads stay on your Atelier server/);
  const items = [...PRIVACY.matchAll(/<li><b>The studio owner’s threads:?<\/b>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
  assert.equal(items.length, 2, 'the tester section and section 6');
  for (const it of items) {
    assert.doesNotMatch(it, /for now without|don’t sync|stay on the device where they were made/, 'no "media stays on the device" left');
    assert.match(it, /including their images and videos/);
    assert.match(it, /Tester sync uses a separate namespace and does not give testers access to the owner’s threads/);
  }
  assert.match(items[1], /The original of a video attached to a question isn’t synced\. Only the frames and preview Atelier took from it are synced\./);
  assert.match(items[1], /Videos over 10 MB wait for Wi-Fi before they upload or download\. The owner can turn on “Download videos on mobile data” to skip the wait\./);
  // the rule rests on navigator.connection, which Safari and Firefox don't have: there, videos sync on any network
  assert.match(SYNC, /connection: \(\) => navigator\.connection \|\| null/);
  assert.match(items[1], /On a phone whose browser reports mobile data or Data Saver, a Wi-Fi rule applies\. [^.]*\. [^.]*\. Chrome on Android reports this\. Safari on iPhone doesn’t, so there videos sync on any network\./);
  // No clean-up of b/ exists (nothing in src/ deletes a blob, and no lifecycle rule covers b/: scripts/check-r2-lifecycle.mjs
  // flags one as dangerous), so the page must not promise one.
  assert.match(items[1], /After that its saved copies are removed, except copies of images, videos and long texts\. Long texts are over about 32 KB, such as long answers or pasted documents\. Those copies are not removed automatically\. One copy can be shared by several threads\. So they stay in that private storage until the owner deletes them there\./);
  assert.doesNotMatch(PRIVACY, /later clean-up/);
  const cache = text(/<li><b>Look-up cache \(Cloudflare\):<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.doesNotMatch(cache, /is the one exception|the only exception/);
  assert.match(cache, /stored separately from your profile and memory, optional synced threads and voluntary feedback/);
  const del = text(/<li><b>Delete conversations and media:<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.match(del, /With thread sync on, Clear this device leaves synced copies in private cloud storage\. Delete synced threads from the Threads drawer instead\./);
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
  for (const words of ['1 GiB limit that counts everything kept there', 'up to 500 threads', 'Deleting a thread leaves its copies of images, videos and long texts (over about 32 KB)', 'until the entire tester cloud namespace is removed', 'are removed 30 days after they were saved']) assert.ok(retention.includes(words), words);
  // "removed 30 days after they were saved" rests on R2 lifecycle rules (30 days) on these two prefixes, which only hold
  // tester trash (x/) and history (v/): keep the mapping, or update the wording.
  assert.match(SERVER, /const split = \{ x: `testers-x\/\$\{hash\}\/`, v: `testers-v\/\$\{hash\}\/` \};/);
  assert.match(text(TOS), /Your cloud storage is limited to 1 GiB and up to 500 threads\. Deleted threads’ saved copies and earlier versions count toward the 1 GiB\./);
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

test('Read aloud names the provider the voices really use (src/tts.js): Google only, since the OpenAI voices were retired', async () => {
  const { TTS_VOICES } = await import('../src/tts.js');
  const { AI_CAPTION } = await import('../public/readaloud.js');
  assert.deepEqual([...new Set(Object.values(TTS_VOICES).map((v) => v.provider))], ['gemini'], 'a new provider: update the privacy row and AI_CAPTION');
  const row = /<tr><td>Google \(Read aloud\)<\/td><td>([\s\S]*?)<\/td><\/tr>/.exec(PRIVACY)?.[1] || '';
  assert.match(text(row), /The answer’s text is sent, including any email, calendar or Drive details it mentions\. It goes to Google’s Gemini API to generate the speech\./);
  assert.doesNotMatch(row, /OpenAI/);
  assert.doesNotMatch(PRIVACY, /OpenAI and Google \(Read aloud\)/);
  assert.match(AI_CAPTION, /sent to Google\./);
  assert.doesNotMatch(AI_CAPTION, /OpenAI/);
});

test('every AI provider the Worker can send prompts to is named as a processor, and xAI (Grok) says owner only and no search', async () => {
  const WORKER = await read('src/worker.js');
  const block = /const PROVIDERS = \{([\s\S]*?)\n\};/.exec(WORKER)?.[1] || '';
  const keys = [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['nvidia', 'anthropic', 'openai', 'gemini', 'zai', 'deepseek', 'meta', 'xai', 'runway'], 'a new provider needs a row in the privacy table (and a name below)');
  const NAME = { nvidia: 'NVIDIA', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google (Gemini', zai: 'Z.ai', deepseek: 'DeepSeek', meta: 'Meta', xai: 'xAI (Grok)', runway: 'Runway' };
  const table = /<h2 id="sharing">([\s\S]*?)<\/table>/.exec(PRIVACY)?.[1] || '';
  const firsts = [...table.matchAll(/<tr><td>([^<]+)<\/td>/g)].map((m) => m[1]).join(' | ');
  for (const k of keys) assert.ok(firsts.includes(NAME[k]), `${k}: named in the processor column (${firsts})`);
  const xai = /<tr><td>xAI \(Grok\)<\/td><td>([\s\S]*?)<\/td><\/tr>/.exec(table)?.[1] || '';
  for (const words of ['owner only', 'testers can’t', 'Auto never starts on one', 'busy or unavailable', 'xAI’s API', 'never turns on Grok’s web or X search', 'Grok Imagine'])
    assert.ok(text(xai).includes(words), `xAI row: ${words}`);
  assert.match(PRIVACY, /<li><b>xAI \(owner only\):<\/b>/);
  assert.match(PRIVACY, /xAI’s Grok Imagine and ByteDance’s Seedance 2\.5 through Runway/);
  assert.match(TOS, /They are Anthropic, OpenAI, Google, NVIDIA, Z\.ai, DeepSeek, Meta, xAI and Runway\. So is ByteDance for Seedance through Runway\./);
});

// ── v89 review, the privacy-copy findings: each disclosure rests on the code fact checked next to it ──
const PRIV = text(PRIVACY);
const section = (re) => text(re.exec(PRIVACY)?.[1] || '');

test('Google Photos picks and Canva imports are disclosed as synced to the owner’s storage (privacy-google-photos-canva-synced-undisclosed)', async () => {
  const [APP, MERGE] = await Promise.all([read('public/app.js'), read('public/sync-merge.js')]);
  // a picked photo becomes an attachment (fetched through /api/photos/file, shrunk to 1280 px) and owner images sync
  assert.match(APP, /fetch\(`\/api\/photos\/file\?u=/);
  assert.match(MERGE, /export const MEDIA_SYNC = Object\.freeze\(\{ image: true, video: true \}\);/, 'image sync changed: update §3');
  assert.match(APP, /const CANVA_THREAD = 'canva-imports';/);
  const google = section(/<h3>How Google user data is stored<\/h3>([\s\S]*?)<\/ul>/);
  for (const words of ['A photo you pick from Google Photos is attached to your message. It is resized to at most 1280 pixels.', 'It also syncs with the owner’s thread to the owner’s private Cloudflare R2 storage',
    'Deleting the thread doesn’t remove that copy automatically', 'through the owner’s thread sync, in the owner’s private Cloudflare storage']) assert.ok(google.includes(words), words);
  assert.doesNotMatch(google, /Email, calendar, Drive and photo content is not stored on our servers/, 'photos are stored when picked');
  assert.doesNotMatch(google, /in your own browser, where you can delete them\./);
  const canva = section(/<li><b>Canva<\/b>([\s\S]*?)<\/li>/);
  assert.ok(canva.includes('A design you import goes into the “From Canva” thread') && canva.includes('synced to the owner’s private Cloudflare storage'), canva);
  assert.doesNotMatch(canva, /a design you import is saved in your browser, like the rest of your Library/);
});

test('Gemini Omni’s 55-day storage is disclosed wherever Omni is used (privacy-omni-55-day-storage)', async () => {
  const OMNI = await read('src/omni.js');
  assert.match(OMNI, /store: true, \/\/ required for background runs/, 'Omni no longer stores: update §6');
  assert.match(OMNI, /interactions are kept 55 days/);
  assert.doesNotMatch(OMNI, /'DELETE'/, 'Atelier deletes interactions now: update "doesn’t ask Google to delete it sooner"');
  const item = section(/<li id="omni"><b>Gemini Omni \(video\):<\/b>([\s\S]*?)<\/li>/);
  for (const words of ['text prompt', 'starting image or still frame', 'finished clip', 'up to 55 days', 'edited or extended later', 'doesn’t ask Google to delete it sooner', 'testers’ Omni videos', 'Video Remix'])
    assert.ok(item.includes(words), words);
  assert.match(section(/<li id="remix">([\s\S]*?)<\/li>/), /Gemini Omni \(which keeps it for up to 55 days: see section 6 ?\)/);
  const providers = section(/<li><b>AI providers:<\/b>([\s\S]*?)<\/li>/);
  assert.doesNotMatch(providers, /briefly/, 'not "briefly": Omni keeps 55 days, prompt caches up to days');
  assert.match(providers, /besides the storage listed above/);
});

test('automatic Read aloud of spoken requests is disclosed: Gemini gets the answer, account details included (privacy-auto-read-aloud-undisclosed)', async () => {
  const { DEFAULT_READ_ALOUD, VOICES } = await import('../public/readaloud.js');
  assert.equal(DEFAULT_READ_ALOUD.auto, true, 'auto read is off by default now: update the row');
  assert.equal(VOICES.find((v) => v.id === DEFAULT_READ_ALOUD.voice)?.provider, 'gemini', 'the default voice is no longer Gemini: update the row');
  const html = await read('public/index.html');
  assert.match(html, /<input type="checkbox" id="readAuto" checked \/><span><span class="ra-auto-title">Read answers to spoken requests<\/span>/);
  const row = section(/<tr><td>Google \(Read aloud\)<\/td><td>([\s\S]*?)<\/td><\/tr>/);
  for (const words of ['because you tapped Read aloud, or automatically when you asked out loud', 'Atelier Assist, Talk or the mic', 'on by default', 'Settings → Read aloud → Read answers to spoken requests', 'including any email, calendar or Drive details it mentions'])
    assert.ok(row.includes(words), words);
  const used = section(/<h3>How Google user data is used<\/h3>([\s\S]*?)<\/ul>/);
  assert.match(used, /also sent to Google’s Gemini speech API to make the audio/, '§3 names the second Google recipient');
  assert.match(text(TOS), /Answers to spoken requests \(Talk or the mic\) are read aloud automatically\. You can turn that off in Settings → Read aloud\. Those readings count against your allowance the same way\./);
});

test('the Runway row names Seedance and the Aleph clip upload (privacy-runway-row-seedance-aleph)', async () => {
  const RW = await read('src/runway.js');
  const { RUNWAY_VIDEO_MODELS, RUNWAY_EDIT_MODEL } = await import('../public/runway.js');
  assert.ok(RUNWAY_VIDEO_MODELS.some((m) => m.runway === 'seedance2_5'), 'Seedance is offered');
  assert.equal(RUNWAY_EDIT_MODEL.runway, 'aleph2');
  assert.match(RW, /export const UPLOAD_TTL_MS = 23 \* 3600 \* 1000; \/\/ runway:\/\/ URIs live 24 h/);
  const row = section(/<tr><td>Runway<\/td><td>([\s\S]*?)<\/td><\/tr>/);
  for (const words of ['Google’s Veo 3.1, xAI’s Grok Imagine and ByteDance’s Seedance 2.5 through Runway', 'Runway Aleph edit, the video clip you attach', 'keeps the upload for about 24 hours', 'testers can’t'])
    assert.ok(row.includes(words), words);
  assert.match(text(TOS), /ByteDance for Seedance through Runway/);
});

test('Anthropic’s web search is disclosed with the rule that keeps it apart from account reads (privacy-web-search-undisclosed)', async () => {
  const [ANTH, APP, ROUTER] = await Promise.all([read('src/anthropic.js'), read('public/app.js'), read('src/tester/router.js')]);
  assert.match(ANTH, /type: 'web_search_20260209', name: 'web_search'/);
  assert.match(APP, /const offerWeb = web && !accountRead;/, 'the agent withdraws search after the first account read');
  assert.match(ROUTER, /if \(p\.webUses\) body\.web_search = true;/, 'testers can search too');
  const row = section(/<tr><td>Anthropic \(Claude\), OpenAI, Google \(Gemini, Gemini Omni video\) and NVIDIA<\/td><td>([\s\S]*?)<\/td><\/tr>/);
  for (const words of ['Anthropic’s web search tool', 'for the owner and testers alike', 'search terms Claude writes from your question and the conversation', 'its search provider', 'only before it reads anything from them', 'switched off for the rest of that answer', 'both account data and outside text'])
    assert.ok(row.includes(words), words);
  assert.doesNotMatch(row, /never run in the same answer/, 'they can: search first, then the accounts');
});

test('prompt caches: every provider that caches is named, DeepSeek’s days, and what the agent read (privacy-prompt-cache-copy)', async () => {
  const WORKER = await read('src/worker.js');
  assert.match(WORKER, /caches a repeated prompt prefix on its own \(OpenAI, Gemini's implicit caching, DeepSeek's context\r?\n\s*\/\/ cache, Z\.ai, xAI, Meta\)/, 'the list of caching providers changed: update §6');
  const item = section(/<li><b>Prompt caches at AI providers:<\/b>([\s\S]*?)<\/li>/);
  for (const words of ['up to 1 hour', 'OpenAI, Google, xAI, Z.ai and Meta cache repeated request starts automatically for minutes to hours', 'DeepSeek caches them for up to a few days', 'can include what the accounts agent read for that answer'])
    assert.ok(item.includes(words), words);
});

test('tester deletion: the owner’s Delete data and the device button are disclosed as they work (privacy-tester-deletion-no-path, -former-tester-device-data-unreachable)', async () => {
  const [ROUTER, LEDGER, HTML, APP] = await Promise.all([read('src/tester/router.js'), read('src/tester/ledger.js'), read('public/index.html'), read('public/app.js')]);
  assert.match(ROUTER, /\/\^testers\\\/\(revoke\|restore\|config\|forget\)\$\//, 'the owner route exists');
  assert.match(LEDGER, /async forgetTester\(sub\) \{/);
  assert.match(HTML, /id="testerForget" hidden>Remove my tester data from this device<\/button>/);
  assert.match(APP, /data-tp="forget"[^>]*>Delete data<\/button>/);
  const s8 = section(/<li><b>Testers:<\/b>([\s\S]*?)<\/li>/);
  for (const words of ['The owner’s Delete data then removes your record, sessions, usage ledger, profile, cloud-sync namespace and feedback.', 'It removes them from the server at once',
    'Remove my tester data from this device', 'also while you can’t sign in', 'threads, Build app data, settings and Read aloud clips', 'clearing this site’s data in your browser'])
    assert.ok(s8.includes(words), words);
  const records = section(/<li><b>Tester records:<\/b>([\s\S]*?)<\/li>/);
  assert.match(records, /the owner’s Delete data \(in the owner’s Testers panel\) removes a tester at once/);
  assert.match(text(TOS), /The owner can then delete your record and cloud data at once/);
  // and the Read aloud promise for a tester's sign-out holds (pass A cleared the clips before the reload)
  assert.match(PRIV, /It stays until Settings → Your data → Clear this device clears it\. It is also cleared when a tester signs out\./);
});

// v91 review (tester-privacy): Delete data runs a second pass (a still-open tab can write for up to a minute after it),
// lifts a revocation (no record is left), and the error reports' network code lives only through its hour.
test('tester deletion copy: the second pass and the re-sign-in are disclosed as the Ledger does them', async () => {
  const LEDGER = await read('src/tester/ledger.js');
  assert.match(LEDGER, /export const FORGET_SWEEP = 10 \* MINUTE;/, 'the second pass waits 10 minutes (then the 10-minute alarm)');
  assert.match(LEDGER, /'CREATE TABLE IF NOT EXISTS forgotten \(sub TEXT PRIMARY KEY, at INTEGER NOT NULL\)'/, 'only the sub is kept for it');
  assert.match(LEDGER, /if \(t\?\.revoked_at\) return refuse\('revoked'\);/, 'admit refuses only a revoked row: a deleted one can come back');
  const records = section(/<li><b>Tester records:<\/b>([\s\S]*?)<\/li>/);
  for (const words of ['the same deletion runs once more 10 to 20 minutes later', 'Until then only their LinkedIn ID is kept, for that second pass',
    'that person can sign in again later as a new tester. They can do so while a spot is free, even if their access had been revoked'])
    assert.ok(records.includes(words), words);
  assert.ok(section(/<li><b>Testers:<\/b>([\s\S]*?)<\/li>/).includes('at once, and once more 10 to 20 minutes later'));
});

test('the error reports’ network code is kept only through its hour, as the Ledger prunes it', async () => {
  const LEDGER = await read('src/tester/ledger.js');
  assert.match(LEDGER, /DELETE FROM client_error_nets WHERE hour < \?', Math\.floor\(now \/ HOUR\)\);/, 'the alarm');
  assert.match(LEDGER, /DELETE FROM client_error_nets WHERE hour < \?', hour\);/, 'each report');
  assert.match(LEDGER, /TICK = 10 \* MINUTE/);
  assert.match(section(/<li id="app-errors">([\s\S]*?)<\/li>/), /one-way keyed code of the network \(never the address itself\)\. The code is kept only until that hour is over \(at most about 70 minutes\)\./);
  assert.doesNotMatch(PRIV, /kept for at most two hours/);
});

test('Google content: attached photos and long texts outlive a deleted thread in the owner’s storage, as src/sync.js keeps blobs', async () => {
  const SYNC = await read('src/sync.js');
  assert.match(SYNC, /content-addressed blobs \(media, long text\), written once with R2's sha256 check, never deleted/);
  const stored = section(/<h3>How Google user data is stored<\/h3>([\s\S]*?)<\/ul>/);
  assert.ok(stored.includes('Delete threads in the app (section 8). Deleting a thread leaves copies of attached photos and of long texts (over about 32 KB). They stay in the owner’s private storage until the owner removes them there.'), 'the copy says what deleting a thread leaves');
  assert.doesNotMatch(stored, /Delete them in the app/);
});

test('the humanizer rewrite rewords the legal pages without changing what they say (v92 review fixes)', async () => {
  // Terms §9: "as far as the law allows" covers the warranty disclaimer and both exclusions, each exclusion is limited
  // to damages arising from your use of the service (as v91's one sentence had it), and the 12-month cap stays as it was
  const s9 = text(/<h2>9\. Disclaimer and limitation of liability<\/h2>([\s\S]*?)<h2>/.exec(TOS)?.[1] || '');
  for (const words of ['As far as the law allows, Atelier carries no warranty of any kind, express or implied.', 'To the same extent, we are not liable for:',
    'indirect, incidental, special, consequential or punitive damages arising from your use of the service;', 'lost data, profits or revenue arising from your use of the service.',
    'Your use of the service includes actions you approved in connected accounts.', 'Our total liability for any claim is limited to what you paid us for the service. It counts only payments in the 12 months before the claim. That amount may be zero.'])
    assert.ok(s9.includes(words), `§9: ${words}`);
  assert.equal(s9.match(/arising from your use of the service/g)?.length, 2, 'the limit sits inside each exclusion');
  assert.doesNotMatch(s9, /Both cover anything|we are not liable for [^:]*damages\./, 'no exclusion without its limit');
  // Read aloud: the voice is AI-generated, in the words the privacy page uses
  assert.ok(text(TOS).includes('The voice you hear is AI-generated.') && text(PRIVACY).includes('The voice you hear is AI-generated.'));
  assert.doesNotMatch(TOS, /No human voice is used/);
  // disclosure to protect users or the service (as the terms say "to protect the service"), never the operator itself
  assert.ok(text(PRIVACY).includes('We may disclose information if required by law. We may disclose it to protect the rights, safety or security of users or the service.'));
  assert.doesNotMatch(PRIVACY, /security of users or Atelier/);
  assert.match(TOS, /to protect the service/);
  // Runway and xAI copies: on the owner's device and in the owner's thread, which syncs its images and videos
  assert.match(await read('public/sync-merge.js'), /export const MEDIA_SYNC = Object\.freeze\(\{ image: true, video: true \}\);/, 'owner media stopped syncing: update the Runway and xAI items');
  for (const label of ['Runway', 'xAI']) {
    const item = text(new RegExp(`<li><b>${label} \\(owner only\\):</b>([\\s\\S]*?)</li>`).exec(PRIVACY)?.[1] || '');
    assert.ok(item, label);
    assert.doesNotMatch(item, /only on the owner’s device/, `${label}: the device does not hold the only copy`);
    assert.ok(item.includes('on the owner’s device. It sits in the owner’s thread, which syncs to the owner’s private Cloudflare storage. Atelier’s server keeps no other copy.'), label);
  }
  // Video Remix: what travels with the owner's thread, with no count that the next sentence contradicts
  const remix = text(/<li><b>Video Remix \(this device\):<\/b>([\s\S]*?)<\/li>/.exec(PRIVACY)?.[1] || '');
  assert.ok(remix.includes('None of these files is synced on its own. Only the plan, settings, new shots’ status and small preview stills travel with the owner’s thread. A finished cut under 16 MB is also added to its thread.'), remix);
  assert.doesNotMatch(remix, /only (?:two|three|four|five|six) things/);
  // the owner's cookie: only an expiry date and a signature
  assert.ok(text(PRIVACY).includes('It holds only an expiry date and a signature. It is never used for tracking.'));
});
