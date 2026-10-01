# Atelier — personal studio (PWA)

Answers · Code · Images · Video · Ideas · App builder — all on **NVIDIA build** free endpoints,
served from one **Cloudflare Worker**.

```
public/            the installable PWA (vanilla JS, no build step)
  index.html       shell
  app.css          design system (darkroom-editorial, per-mode accents)
  studio.css       responsive studio shell, navigation and component refinements
  data-safety.js   backup validation and interrupted-response recovery
  app.js           app logic, model catalog, IndexedDB threads
  sw.js            offline shell (API traffic is never cached)
  vendor/          marked, DOMPurify, highlight.js (vendored)
src/worker.js      serves /public + proxies an allow-list of NVIDIA endpoints
wrangler.jsonc     Worker config
```

## Why a proxy?
NVIDIA's APIs don't allow browser CORS. The Worker forwards only these routes:

| App route | NVIDIA upstream |
|---|---|
| `POST /api/chat` | `integrate.api.nvidia.com/v1/chat/completions` (streamed) |
| `GET /api/models` | `integrate.api.nvidia.com/v1/models` |
| `POST /api/genai/<org>/<model>` | `ai.api.nvidia.com/v1/genai/<org>/<model>` |
| `POST /api/fn/cosmos3-nano` | `api.nvcf.nvidia.com/v2/nvcf/pexec/functions/<id>` (allow-listed) |
| `GET /api/status/<id>` | `api.nvcf.nvidia.com/v2/nvcf/pexec/status/<id>` (202 polling) |

## Access & keys
Atelier is **passcode-only**. All provider keys live in Worker secrets; a device only needs the passcode.
```bash
npx wrangler secret put APP_PASSCODE
npx wrangler secret put NVIDIA_API_KEY      # any of these four
npx wrangler secret put ANTHROPIC_API_KEY   # (+ ANTHROPIC_WORKSPACE_ID for org-level keys)
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
```
Connected accounts use more secrets (GITHUB_TOKEN, STRIPE_API_KEY, CLOUDFLARE_API_TOKEN, RAILWAY_API_TOKEN,
SLACK_USER_TOKEN, GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, CANVA_CLIENT_ID + CANVA_CLIENT_SECRET) — see Settings → Connections.

### LinkedIn testers
Up to 25 people can sign in with LinkedIn and use paid models under a hard spending ceiling. The passcode path is
unchanged: a request with the passcode is always the owner, even if it also carries a tester cookie.
Design: `docs/superpowers/specs/2026-09-30-atelier-tester-access-design.md` plus the addendum (the addendum wins).

- **Sign-in:** `GET /api/li/start` → LinkedIn OpenID Connect (`openid profile email` only, never `w_member_social`) →
  `GET /api/li/callback` → `/?tester=welcome|full|revoked|paused|denied|error`. The session is a random token in the
  `__Host-atelier_tester` cookie (HttpOnly, Secure, SameSite=Strict, 30 days); only its SHA-256 is stored. The LinkedIn
  access token is used once for userinfo and never kept. `POST /api/li/logout` ends the session. `GET /api/li/spots`
  → `{spotsLeft, cap, paused}` (public, cached 60 s).
- **Deny by default:** a tester request goes only through `src/tester/router.js` (`TESTER_ROUTES`): `GET /api/tester/me`,
  `GET/PUT /api/tester/profile` (their own "You", ≤ 300 KB, kept in the Ledger), `POST /api/chat`, OpenAI / Meta / Nano
  Banana images, Veo (lite and fast; one video, ≤ 8 s, ≤ $1.00) with polls and downloads of their own jobs only, and
  `/api/video/*` for their own uploads (≤ 200 MB). Everything else answers `403 {code:"owner_only"}`. Non-GET tester
  requests must come from `https://atelier.ciprari.ai` (or `http://127.0.0.1:8787`). No NVIDIA and no free models.
- **The meter (`src/tester/ledger.js`, Durable Object `Ledger`, SQLite):** every metered call reserves its worst case
  (`src/tester/prices.js`: chat ≤ $0.25 per call, ≤ $0.50 with web search) before the provider is called, then settles to
  the provider's reported usage (`src/tester/usage.js`), never above the reservation. Unfinished reservations settle at
  the full amount after 15 minutes. Limits: $1/day and $10/month per tester, $100/month for all testers together. Every
  metered response carries `x-tester-allowance: {"dayLeft","monthLeft","poolLeft"}` (micro-dollars). Refusals are
  `402 tester_budget {scope, resetsAt}`, `503 tester_paused`, `403 tester_model | tester_owner | tester_origin`,
  `413 tester_too_large` or `401 tester_signin`; when the server swaps the model (web search too big for Opus → Sonnet 5.5,
  a long video on 3.1 Pro → 3.8 Flash) the response says so in `x-tester-model`.
- **Owner controls (passcode):** `GET /api/testers` (config, pool, last refused sub, roster with today/month spend),
  `POST /api/testers/revoke {sub}`, `/restore {sub}`, `/config {cap?, paused?, day_limit?, month_limit?, pool_limit?, preview_subs?}`
  (limits in micro-dollars; the pool can't go above $1,000). A fresh Ledger starts **paused**; while paused only subs in
  `preview_subs` can sign in and spend (still within their limits). Tester records (profile included) are deleted 90 days
  after last use.
- **Setup:** add `https://atelier.ciprari.ai/api/li/callback` and `http://127.0.0.1:8787/api/li/callback` to the LinkedIn
  app's authorized redirect URLs, and set `npx wrangler secret put LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
  The first deploy adds the `Ledger` class (migration `v2`).

### Read aloud (the Atelier voice)
`POST /api/tts` (`src/tts.js`) speaks one segment of an answer in a soft, human voice. The client sends only
`{voice, text}` or `{voice, preview: true}`; the model, the voice brief (`TTS_BRIEF`, versioned by `TTS_BRIEF_V`) and the
format are server constants. Voices: `atelier` (default: OpenAI `gpt-4o-mini-tts-2025-12-15`, voice marin), `cedar`,
`sage` (same model) and `sulafat` (Gemini `gemini-3.8-flash-lite-tts`); `device` (the browser's own voice) never reaches
the server. OpenAI voices stream `audio/mpeg`; Sulafat answers a whole `audio/wav`. Text is capped at 4,000 characters per
request for the owner and 1,000 *spoken units* for testers (`spokenUnits`: a character each, plus 3 per digit, 2 per
symbol read as a word and 2 per Chinese/Japanese/Korean character, since those take longer to say; `public/readaloud.js`
sizes its segments with the same count). Gemini's output is bounded at the source (`maxOutputTokens` 4,369, about 175 s,
what fits in one request's 8 MB of audio); an answer longer than that anyway is settled at its real length and answered
with 502. Errors are our own (`400 bad_request`, `413 too_large`, `429 tts_busy` with `retry-after`, `502/503
tts_unavailable`): provider error bodies and headers are never passed on. Settings previews are cached per voice, brief
version and preview line (`PREVIEW_ID`, a hash of `PREVIEW_TEXT`) in the data center's cache for 30 days. Testers are
metered like chat: the worst case (`ttsWorstCase` on the spoken units, about $0.094 per 1,000 on OpenAI; for Gemini at
most its `maxOutputTokens`) is reserved, then settled from the `speech.audio.done` usage (OpenAI) or the seconds of audio
returned (Gemini, 25 tokens/s); a tester may start about 20 paid read-aloud requests a minute (the `LI_LIMIT` binding,
keyed `tts:<sub>`; past it `429 tts_busy`, `retry-after: 30`). `GET /api/tester/me` lists the tester's voices in
`models.tts` and `features.tts`. Change the default voice by editing the `atelier` row of `TTS_VOICES` and bumping
`TTS_BRIEF_V`; a new `PREVIEW_TEXT` needs only the matching `PREVIEW_ID` in `public/readaloud.js` (a test checks it). The
answer text is sent to OpenAI (or Google for Sulafat) to make the audio, and the voice is AI-generated.

### Canva
Canva uses OAuth 2.0 with PKCE. Each connected Canva account's refresh token is kept in KV (`canva_accounts`), and access
tokens are cached separately (`canva_access:<id>`). Canva refresh tokens are single-use: each refresh stores the
replacement token immediately, and parallel refreshes are shared, so the old token is never used twice.
1. Turn on multi-factor authentication for your Canva account (Canva account settings → Login & security; if you sign in
   with Google/Apple, set a Canva password first). The Developer Portal has required MFA to create an app.
2. https://www.canva.com/developers/apps → **Create an app** (name ≤ 18 characters, e.g. "Atelier"). Choose **Public** unless
   your team is on Canva Enterprise. The choice is permanent, and you don't need to submit a public app for review to connect your own account.
3. **Outside Canva → Start integrating**; under Configuration make sure **Canva REST APIs** is on. Copy the Client ID and
   **Generate secret** (starts with `cnvca`, shown once).
4. Scopes: tick exactly **design:meta Read**, **design:content Read + Write**, **asset Read + Write**, **profile Read**.
5. Redirect URLs (exactly, no trailing slash): URL 1 `https://atelier.ciprari.ai/api/oauth/canva/callback`,
   URL 2 `http://127.0.0.1:8787/api/oauth/canva/callback`. Canva rejects `localhost` redirect URLs.
6. `npx wrangler secret put CANVA_CLIENT_ID` and `npx wrangler secret put CANVA_CLIENT_SECRET`. For local testing, also
   add both to `.dev.vars`. Run `npx wrangler dev --local-upstream 127.0.0.1:8787`: without that flag, wrangler presents
   requests as coming from the custom domain, so the Worker would send Canva `http://atelier.ciprari.ai/...` as the redirect.
7. Settings → Connections → **Connect Canva**. Image results then offer **Send to Canva** (`POST /api/canva/send-image`),
   and the agent gets `canva_designs`, `canva_design`, `canva_export` (read), plus `canva_create_design` and `canva_upload_image`
   (these need your approval).
   The Library's **From Canva** view uses `GET /api/canva/designs`, `GET /api/canva/designs/<id>/formats` and `POST /api/canva/import` (PNG pages, max 10, or one MP4), then downloads each export through `GET /api/canva/file`, which only fetches `https://export-download.canva.com` links (PNG/JPEG/MP4, max 100 MB, no redirects to other hosts).

## Develop / deploy
```bash
npm install
npx wrangler dev          # http://localhost:8787
npx wrangler deploy      # → https://atelier.ciprari.ai
```

## Verification and UI review

```bash
npm run check            # syntax checks
npm test                 # backup safety, recovery and offline-cache regression tests
npm run review:ui        # isolated fixture at http://127.0.0.1:8791
npx wrangler deploy --dry-run --outdir .review-build
```

The isolated UI fixture uses the passcode `review-only`. It serves canned responses and a small interactive test app, never loads `.dev.vars`, and never calls providers or connected accounts. It is a development script, not part of the deployed app. Real development continues to use `npm run dev` on port 8787.

The September 2026 UI pass adds desktop workspace navigation, balanced mode cards, phone-sized controls, clearer onboarding, grouped settings, keyboard navigation and modal focus handling. Thread imports are validated before a single atomic write, use new IDs to preserve existing work, and discard stale tool approvals. Backups explicitly contain threads and creations; they exclude passcodes, profiles and account connections. Clearing a device now removes Atelier's saved sign-in backup and legacy thread database as well as current threads, without clearing other applications' local storage.

Validation: 14 regression tests; syntax checks; production bundle dry run; production-dependency audit with zero reported vulnerabilities; browser checks at 320px, 390px and 1440px, in dark and paper themes. Browser checks cover draft preservation, keyboard mode selection, streamed fixture responses, thread search, settings, app preview interaction, code view, full-screen view and library persistence. Local Worker smoke checks confirm the shell loads, unauthenticated profile requests return 401, and API responses are not cached.

Release verification still requires the deployed environment: real provider generation and streaming, image/video output and editing, OAuth connections, browser-extension pairing and action approval, and a service-worker upgrade on an installed PWA. The automated tests cover offline cache behavior but do not replace an installed-device check. Atelier remains a personal, shared-passcode app; this pass does not add multi-user identity or tenant isolation. No production deployment is performed by the review commands.

## Using it
- **Modes**: Alt+1…6, or slash commands: `/img`, `/vid`, `/code`, `/idea`, `/build`, `/ask`.
- **Ask** with an image attached → vision model. **Deep think** → reasoning model.
- **Image**: FLUX.1 dev / FLUX.2 klein / FLUX.1 schnell. Attach a photo in Image mode to *edit* it (FLUX.2 klein).
- **Video**: NVIDIA Cosmos 3 Nano when the key has access; otherwise a **Motion still** — FLUX paints the frame and the browser films a slow push-in/pan (MP4/WebM).
- **Ideas** → each card can *Expand*, *Build it* or *Visualize*.
- **Build**: single-file apps previewed in a sandbox; keep chatting to refine; download as `.html`.
- **Library** collects every image, video and app. Threads live in IndexedDB; export/import in Settings.
- Models are editable per role in Settings ("Load my model catalog" lists every model your key can use). Retired models fall back automatically.

## Atelier Browser (Chrome / Edge extension)
`extension/` is a Manifest V3 companion that lets the agent use your real, logged-in browser.
- Talks **only** to the Atelier page (content script on atelier.ciprari.ai / localhost:8787 ↔ `window.postMessage`).
- Free: list tabs, read a page, open a page, list page controls, bring a tab to the front.
- Needs your approval in Atelier: click, type. The approval card shows the real target element and page.
- Since v1.3.0 the extension also asks on the computer itself before every click or type (a small Atelier Browser window:
  Deny is the default, Allow unlocks after ~1 s). After a Deny or timeout, further click/type from that source is refused
  for 30 s (doubling, up to 10 min). Password and payment fields are refused outright.
- Hard block: never types into password, payment or ID fields.

Install: download `/atelier-browser.zip` (Settings → Connections → Get extension), unzip, then
`chrome://extensions` → Developer mode → **Load unpacked** → pick the `atelier-browser` folder.
`npm run deploy` re-packs the zip before deploying. The production zip only runs on atelier.ciprari.ai; for `wrangler dev`
use Load unpacked on `extension/` or `node scripts/pack-extension.mjs --dev` (writes `atelier-browser-dev.zip`, never served).

### Remote browser (use your computer's browser from your phone)
The extension keeps a WebSocket open to the `Relay` Durable Object (`src/relay.js`) while Chrome is running.
Opening Atelier on the computer pairs the extension automatically (`/api/relay/pair` issues a device token; re-pairing
revokes the old one). Other devices send browser commands through `/api/relay/cmd` (passcode + approval for click/type).
Works whenever the computer is awake and Chrome is open (minimized is fine).
