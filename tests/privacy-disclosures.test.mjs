// The privacy page and terms must name what the code actually asks for and loads: every Google and Canva OAuth scope
// (src/tools.js; one consent asks for all of them) and the Cloudflare Web Analytics beacon the edge injects (allowed by
// public/_headers' CSP). A new scope or beacon without a disclosure fails here.
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
