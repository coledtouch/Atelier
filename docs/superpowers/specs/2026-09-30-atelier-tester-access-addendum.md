# Atelier — LinkedIn tester access: owner addendum

Date: 2026-09-30 · Applies on top of `2026-09-30-atelier-tester-access-design.md` (the "spec").
Wherever this addendum and the spec disagree, the addendum wins. Everything not mentioned here stays as the spec says.

Revised 2026-11-13 (v114 review): A2, A3, A7b, A8.1 and A8.2 now describe the code as it is. Tester video is Gemini Omni (since v80), every Read aloud voice is Gemini speech (since v80), and dictation is `gpt-transcribe`, billed by duration.

## A1. Credentials and LinkedIn

- Secrets are **`LINKEDIN_CLIENT_ID`** and **`LINKEDIN_CLIENT_SECRET`** (already set on the Worker). Do not use the spec's `LI_*` names.
- Scope `openid profile email` only. Never request `w_member_social`.
- Redirect: `https://atelier.ciprari.ai/api/li/callback`, plus `http://127.0.0.1:8787/api/li/callback` for development.
- The owner is on **Workers Paid**.

## A2. Testers keep video (owner decision)

Video uploads are allowed for testers:
- Routes: `POST /api/video/upload/{start,chunk,query,cancel}`, `GET/DELETE /api/video/file`.
- **Ownership:** every upload session and Gemini file name is recorded to the tester's `sub` in the Ledger `jobs` table.
  - Queries, chunks, cancels, file gets and deletes work only on the tester's own entries.
  - A `video_file` chat part must reference a file owned by the requesting tester. Otherwise the request gets `403 {code:"tester_owner"}`.
- **Tester full-clip limits:** 200 MB and 180 s. Larger clips go as frames; the client already falls back. A tester may start 10 clip uploads a UTC day (`DAILY_UPLOADS`).
- **Metering:** chats carrying video parts are metered like any chat.
  - The worst-case reserve adds video and audio tokens from the file's duration (Gemini file `videoMetadata`): 332 tokens a second (`GEMINI_VIDEO_TOKENS_PER_SECOND`: about 300 video and 32 audio). Every `video_file` part is priced, a repeated clip too, and a request holds at most 4 of them.
  - A clip whose length Gemini hasn't reported yet is refused (409 `tester_video_not_ready`), never guessed. A clip over 180 s is refused (413).
  - Settle from `usageMetadata` of the native `streamGenerateContent` stream.

Video mode (as built: v80 moved tester video from Veo to Gemini Omni, because Veo 3.1 on the Gemini API shut down on 2026-10-22):
- Tester video is Gemini Omni Flash (`gemini-omni-1.1-flash`), on the tester router's own routes (`src/tester/router.js`, `src/omni.js`): `POST /api/omni/start`, `GET /api/omni/status/<id>`, `GET /api/omni/video/<id>` and `POST /api/omni/cancel/<id>`. Veo's `predictLongRunning`, operation polls and file downloads are gone for everyone.
- Free NVIDIA Cosmos and the motion still are not offered to testers (A7b).
- One clip per request: 720p or 1080p, 4, 6 or 8 s, no tools. The start body is rebuilt from a whitelist (`shapeOmni`).
- Reserve = seconds × the per-second price × 1.25 (`veoCost`), taken before Google is called, and never above $1.00 (A7b).
- Settle: when the tester's status check sees the interaction finish. A clip settles from Google's reported usage (`omniActual`), or at its per-second price when none is reported. A filtered, failed or cancelled one is $0. A reservation whose finish no status check sees settles in full after 15 minutes (`expireStale`); that includes a clip the tester stopped, since the app doesn't check on it again.
- A start Google refuses bills nothing ($0). No answer, a garbled answer or a gateway's 502, 504 or 52x keeps the reservation, as on the owner's path: Google may have started the clip (v114).
- Status, download and cancel work only for interactions this tester started (the Ledger `jobs` table, `omni:<id>`). An Omni job row is kept 55 days (`OMNI_JOB_TTL`), as long as Google keeps the interaction and the app offers Edit; other job rows are kept 7 days (v114: every row went after 7).
- An edit (`previous`) must name the tester's own earlier clip. It is sent no duration: Google films it at that clip's length. So an edit is held at the longer of that clip's length and the seconds the request names (v114: it was held at the seconds named).

## A3. Feature-rich tester mode (owner decision: "I want it feature rich")

This replaces the spec's §8 "Hidden and off in tester mode" list. Everything below is metered by the Ledger under the same limits: $1 per day and $10 per month per tester, and the $100 monthly pool.

- **Helpers ON:** `nameThread`, `enhance`, `planTasks` and `learnFrom` run for testers, each as its own metered call on the fast or helper models.
- **Web search ON:** Anthropic `web_search` with `max_uses: 3` per round.
  - pause_turn continuation stays limited to 1 round.
  - The search fee (per the claude-api reference) is included in the reserve.
- **Reasoning:** `reasoning_effort` up to `high` is allowed; `max_tokens` still bounds the reserve.
- **Images:** `n` up to 4, reserved per image. Edits are allowed on allow-listed image models (`POST /api/x/openai/images/edits`). OpenAI's variations route is not on the tester list.
- **Per-tester "You":**
  - Profile, bio, writing style, memory and learned facts are stored server-side per LinkedIn `sub`, in the Ledger DO or KV key `me:t:<sub>`. They are never in the owner's `me` key.
  - Tester routes: `GET/PUT /api/tester/profile`, with a size cap such as 300 KB.
  - "Learn my style" and history-import analysis are metered.
  - The profile is deleted together with the tester record.
- **Client-side features unchanged for testers:** Library, viewer, downloads, the device read-aloud voice, the browser's own speech recognition for dictation, and thread export/import.
  - The AI Read aloud voices (`POST /api/tts`), server dictation (`POST /api/transcribe`) and Look up (`GET /api/lookup`, `/api/lookup/img`) are tester routes too: see A8.
  - Meta Muse Image (`POST /api/x/meta/images/generations`) is a tester image route too (owner decision): see A7b.
  - The Gemini image (`generateContent`) routes accept `v1` as well as `v1beta`, for the client's v1 fallback. Veo's `predictLongRunning`, operation polling and file downloads (`files/<id>:download`) went with the Veo 3.1 shutdown (2026-10-22): tester video is Gemini Omni on `/api/omni/*` (A2).

Public before identity (dispatched in `src/worker.js` before `identify()`, so neither the passcode nor a tester session decides them; `PUBLIC_PATHS` in `src/tester/router.js`). A request carrying `x-app-pass` still passes the passcode lockout guard first (`passcodeGate` in `src/guard.js`: unless it carries the owner's clearance cookie and the right passcode, it passes the per-network `GUARD_LIMIT` throttle, then the Guard Durable Object counts a wrong passcode against its network, an IPv4 address or IPv6 /64, in one serialized step, and answers 429 once that network is locked or guessing is paused for everyone). Browsers never send that header with a CSP report, and the app's own health check and sign-in calls don't send it either, so in practice it has no effect on these routes:
- `GET /api/health`, and the LinkedIn sign-in routes `/api/li/*` (spec).
- `POST /api/csp-report`: Content-Security-Policy violation reports from browsers (`public/_headers` report-uri / report-to).
  - Only `application/csp-report` or `application/reports+json` bodies (case-insensitive, parameters allowed); any other content type gets 415 and logs nothing.
  - Each report becomes one PII-free log line (directive, blocked origin, page and source as origin + path, line, column, disposition); no IP, user agent, query string, sample or cookie. Fields are read only as strings or finite numbers, so a hostile body can't throw.
  - Throttled per IP (`LI_LIMIT`, key `csp:<ip>`) and per isolate (60 lines a minute); never touches the Ledger or a tester record, and touches the Guard only through the passcode lockout guard above, when a request carries `x-app-pass`.
- `POST /api/clearance/end`: removes the caller's own `__Host-atelier_owner` cookie (the owner's passcode-guard clearance, `src/guard.js`); 204, nothing else. The app sends it when the owner clears the passcode in Settings or uses Clear this device. Only from the app's own pages: an Origin outside `ALLOWED_ORIGINS`, none at all, or a `Sec-Fetch-Site` other than `same-origin` gets 403 with no Set-Cookie (another site's form POST could otherwise strip the owner's clearance).
- `GET /api/relay/ws`: the browser extension's WebSocket. The Relay authenticates it only by its device-token subprotocol, so it is dispatched before `identify()` (a tester cookie in the owner's browser can't turn the extension away). Testers and anonymous callers get the Relay's own 426 / 401, never a socket. The rest of `/api/relay/*` stays owner-only.

Still owner-only (deny by default):
- `/api/me` (the owner profile), `/api/diag`, `/api/models`, `/api/tools*` and `/api/relay/*` (except `relay/ws`, above), plus the browser extension.
- `/api/runway/*` (Runway video, A8).
- The `oauth/`, `accounts/`, `photos/` and `canva/` prefixes. Testers cannot connect their own Canva until the Canva app passes Canva's review.
- `/api/testers*` admin routes, and any route not on the tester allow-list.

Tester session lookups (v114 review fix; `identify` in `src/tester/auth.js`):
- A tester cookie the isolate hasn't seen in the last 60 s is looked up in the Ledger. Anyone can send a well-formed cookie, so those lookups are limited per network: `LI_LIMIT`, key `sess:<network>`, 20 a minute (an IPv6 address counts by its /64).
- Past the limit nothing reaches the Ledger. The request gets 429 `session_busy` with `retry-after: 30` (503 on `tester/sync/*`, which the sync client retries), and the cookie is left alone, so a real tester on a busy network stays signed in.
- A live tester rarely counts: an answer is cached for 60 s, and the minute's re-check of a session the isolate last saw live skips the limit. Only a cookie new to the isolate is counted.
- Sign-out (`POST /api/li/logout`) shares the limit for a cookie the isolate doesn't know as a live session. Past it the Ledger isn't called; the browser's cookie is cleared all the same, and that session ends when it expires.

## A4. Testing while paused (review fix)

- New config key `preview_subs`: a JSON array of LinkedIn subs, default `[]`, edited only by the owner via `POST /api/testers/config`.
- While `paused=1`:
  - `admit()` returns `paused` for everyone except a sub in `preview_subs`.
  - `reserve()` fails for everyone except a preview sub.
  - Preview subs remain bound by their own day and month limits and the pool limit.
- The Ledger remembers the **last refused sub** (with name and time). The owner Testers panel shows it with an "Add to preview" button.
- Rollout step 4 becomes:
  1. Deploy paused.
  2. The owner signs in once and is refused.
  3. He adds his sub to preview.
  4. He tests while the reviewer checks.
  5. He unpauses.

## A5. Tests (review fix)

- The deny-by-default sweep (spec §11 #1) enumerates routes from the router's own table and prefix list, not from a hand-kept list. Newly added routes (for example `/api/video/*`) are therefore covered automatically, including the owner/tester split for the new tester video and profile routes.
- Add Ledger tests for:
  - preview_subs while paused
  - video reserve and settle
  - the generated-video reserve (Veo then; Gemini Omni since v80)
  - the web-search fee
  - image n ≤ 4

## A6. Privacy and terms

In addition to spec §10, the privacy page states that each tester's profile, style and memory text is stored server-side, alongside the usage ledger. This data is deleted with the tester record (90 days after last use, or on request). Video files uploaded for analysis are held by Google's Gemini Files API for up to 48 hours, then deleted.

## A7a. Branding for launch (owner-supplied assets in `brand/`)

Assets:
- `brand/atelier-linkedin-promo-4x5.webp` (the LinkedIn promo)
- `brand/atelier-mark-transparent-512.png` (the transparent "A")
- `brand/atelier-promo-4x5.mp4` (the promo video)
- `public/og/atelier-share.png` (a 1200×628 link-preview card cut from the promo)

Requirements:
- **Signed-out / tester sign-in screen:** mirrors the promo.
  - The "A" mark and "Atelier" wordmark.
  - The serif headline "Come make" / *"something yours."*, with the second line italic in the Ask accent.
  - A LinkedIn-blue "Sign in with LinkedIn" button with the "in" logo, following LinkedIn's sign-in button guidance.
  - A line "**25 tester spots.** Paid models included.", with a live spots-left count when the Ledger reports it.
  - The owner passcode entry stays available but secondary.
- **Link previews:** `og:title` "Atelier — Come make something yours.", `og:description` "25 LinkedIn tester spots. Paid models included. Built by Cole Ciprari.", `og:image` https://atelier.ciprari.ai/og/atelier-share.png (1200×628), `og:url`, and `twitter:card=summary_large_image`.
- **Header mark:** use the transparent "A" (`/icons/atelier-mark-96.png`) without the dark tile in the dark theme. Keep a subtle tile in the light Paper theme, for contrast.

## A7b. Pricing-driven rules (src/tester/prices.js, checked 2026-09-30) and owner decisions

- **No NVIDIA for testers (owner decision).** NVIDIA's free API tier is meant for development and testing.
  - Testers can't use `/api/genai/*`, `/api/status/*` or `/api/fn/*` (FLUX, Cosmos, the motion still), or any NVIDIA chat model.
  - Free NVIDIA entries stay out of `TESTER_MODELS`, `TESTER_IMAGE_MODELS` and `TESTER_VIDEO_MODELS`.
  - Tester images come from GPT Image, Nano Banana and Meta Muse Image, and tester video from Gemini Omni (Veo until v80), all metered.
    - Meta Muse Image (owner decision; the route was already live, recorded 2026-10-01): `POST /api/x/meta/images/generations` on the owner's `META_API_KEY`, `src/tester/router.js` `metaImages`. Only model `muse-image-1.0` (`TESTER_IMAGE_MODELS`); a prompt of up to 32,000 characters; `n` 1 to 4 (`LIMITS.imageN`); `size` one of the model's `sizes` in prices.js (`1024x1024`, `1024x1280`, `1536x1024`, `1536x864`, `864x1536`), anything else becomes `1024x1024`; `response_format` `b64_json` (default) or `url`; any other field is dropped; a 24 MB body cap (`LIMITS.imageBody`).
    - Metered like the other image routes: reserved at $0.01 x `n` x the 1.25 margin, settled at $0.01 per image returned (`imageActual`; failed or filtered images aren't billed).
  - In tester mode the client hides the motion-still and NVIDIA options. Fallback chains skip NVIDIA, so they never end on a model the tester can't use.
- **Per-call chat cap stays $0.25, with exceptions:**
  - Web-search calls get a $0.50 cap.
  - Tester web calls run with Anthropic fallbacks off, and `max_uses` is the largest of 3, 2 or 1 that fits.
  - If not even 1 fits on the chosen model, that call uses Sonnet 5.5, and the meta line notes it.
- **Generated video for testers (Gemini Omni; Veo until v80):** a call is admitted only if its worst case fits the tester's remaining day, month and pool, and never above $1.00 (`VEO_CALL_RESERVE_CAP`).
  - The client offers only durations and resolutions that fit, and explains when one doesn't. At $0.10136 a second at 720p, 4 s (reserved at $0.51) and 6 s ($0.76) fit. 8 s ($1.01) and every 1080p length don't.
  - `gemini:gemini-omni-1.1-flash` is the only tester video model in prices.js (`TESTER_VIDEO_MODELS`). The Veo ids left the table with the Veo 3.1 shutdown.
- **Video chats on Gemini 3.1 Pro** may not fit $0.25 at the long-context price tier. The router then uses Gemini 3.8 Flash for that call, or refuses with a clear `tester_budget` message.
- **Router hygiene from the pricing pass:**
  - Force an explicit `size` and `quality` on GPT Image requests; app.js sends none on some edits.
  - Strip Gemini `extra_body` / `cached_content`.
  - Exclude base64 bytes from the text-token estimate, and price images by the per-image rule.
  - Map `PriceError` `unpriced_images` / `no_vision` to a non-`tester_` code, so the client's fallback moves on to a vision model.
  - Keep prices.js `MIN_OUTPUT` in step with the anthropic.js and gemini.js clamps.
- **The Ledger starts paused.** A fresh Ledger initialises with `paused=1`, so the first deploy is safe without a manual step. The owner unpauses in the Testers panel after preview testing.
- **Public spots count:** `GET /api/li/spots` returns `{spotsLeft, paused}`, cached for 60 s, with no personal data. The sign-in screen uses it for "N of 25 tester spots left".

## A7. Order

1. Ship the in-flight video-upload release and the hardening pass.
2. `git init` and commit a full snapshot, ignoring `.dev.vars`, `.wrangler` and `node_modules`.
3. Implement the spec plus this addendum.
4. Deploy with `paused=1`.

## A8. Read aloud, dictation, Look up and Runway (owner decisions, 2026-10-01)

### A8.1 Testers get the AI Read aloud voices, metered against their own allowance (owner decision, 2026-10-01)

Every AI voice is Google Gemini speech since v80. OpenAI `gpt-4o-mini-tts` retires on 2027-01-06 with no successor, so its voices, its 50-tokens-a-second assumption and the cut-off clock that bounded its stream are gone from the code.

- **Route:** `POST /api/tts` on the tester allow-list (`src/tester/router.js`); `src/tts.js` validates the body and calls the provider, the router reserves and settles.
  - Voices: `atelier` (Gemini `gemini-3.8-flash-tts`, prebuilt voice Achernar) and `sulafat` (Gemini `gemini-3.8-flash-lite-tts`, prebuilt voice Sulafat), each only while its model is in `TESTER_TTS_MODELS` and `GEMINI_API_KEY` is on the server.
  - The retired ids `cedar` and `sage` are still taken, and read as `atelier` (`RETIRED_VOICES`).
  - The client sends only `{voice, text}` or `{voice, preview: true}`. The server adds the voice style.
- **Limits:**
  - At most 1,000 spoken units per request (`TTS_LIMITS.testerChars`, counted by `spokenUnits`: plain prose is one unit per character, digits and CJK characters weigh more). The client segments longer answers.
  - A 16 KB request body (`TTS_LIMITS.bodyBytes`).
  - 20 requests a minute per tester (`LI_LIMIT`, key `tts:<sub>`); past it, 429 `tts_busy` with `retry-after: 30`.
- **Reservation** (`ttsWorstCase`): priced on the ceiling units (`ttsCeilingUnits`: symbols, emoji and CJK read as words), not on the spoken units, and at the standing price, never the promo price.
  - Audio: `ceil(units / 8)` reserved seconds x 32 audio tokens a second (`reserveTokensPerSecond`), at the audio rate, and at most the voice's output bound (`GEMINI_MAX_OUTPUT_TOKENS`: 4,369 tokens). Google publishes 25 tokens a second, but a live owner read logged about 31.8 for Sulafat. Reserving at 25 set `maxOutputTokens` too low, so slow reads stopped early at `MAX_TOKENS`.
  - Input: `ceil(units / 3) + 200` tokens (`TTS_INSTRUCTION_TOKENS`) at the text rate.
  - All of it x the 1.25 margin. Refused above the $0.25 per-call cap (`PER_CALL_RESERVE_CAP`).
- **Bound:** Gemini is held at the source. The request's `maxOutputTokens` is the reserved audio tokens (`ttsReserved`), so Google can't make, or bill, more audio than was reserved.
- **Settle** (`ttsActual`):
  - Refused by the provider (an HTTP error answer): $0.
  - Finished: max(the reported output tokens, the seconds of audio returned x 25 tokens a second) at the audio rate, plus the reported prompt tokens at the text rate. The reported count usually wins (about 31.8 a second). It can't pass `maxOutputTokens`, and the seconds estimate is capped at the same bound (`maxAudioTokens`). The reservation therefore stays a true ceiling. Promo prices apply through 2026-12-31, then the standing ones.
  - An answer with usage but no audio settles on that usage. An answer with audio but no usage settles on its seconds.
  - More audio than one request may return (8 MB decoded) was made and billed: it settles at its length, and the client reads that passage with the device voice.
  - No usage and no audio, an answer that can't be read, or a call that fails once it was sent: the full reservation stands.
  - The Ledger records at most 4 x the reservation (`OVERRUN`).
- **Settings previews:** one clip per voice is kept in the serving data centre's edge cache (`caches.default`) for 30 days. A cached preview costs nothing. A miss is reserved and settled like any other request.
- **When the allowance is out**, or a passage would take too long to say in one request, the client reads with the device voice (`speechSynthesis`), which sends nothing to Atelier.
- **Privacy:** the text read aloud goes to Google (privacy page §5). Clips are cached only on the device (browser Cache Storage, about 30 MB / 200 clips), cleared by Clear this device or a tester sign-out. The ToS states the typical price and the rate limit.

### A8.2 Dictation for testers (metered)

- `POST /api/transcribe` is on the tester allow-list (`src/transcribe.js` checks the recording and calls the provider; the router reserves and settles). The client uses it only where the browser can't transcribe speech itself (iPhone and iPad, for example). Elsewhere the browser's own speech recognition runs first and touches no allowance.
- **Providers:** OpenAI `gpt-transcribe` first. Gemini `gemini-3.5-flash-lite` (metered as `gemini:gemini-3.5-flash-lite#stt`) is the fallback when OpenAI has no key, is down or busy, times out or refuses the file format. It also reads the containers OpenAI doesn't take (Ogg, FLAC).
- **Reservation** (`sttWorstCase`), for each provider that runs:
  - OpenAI bills by the length of the audio, $0.0045 a minute. It is reserved on the recording's seconds x that price x the 1.25 margin. Only a WAV says how long it is (its header). Any other container is reserved on its size, at 1,000 bytes a second (`STT_MIN_BYTES_PER_SECOND`, an assumption: 8 kbit/s).
  - A recording whose OpenAI reservation would pass the $0.25 per-call cap (a non-WAV file over about 2.7 MB) goes to Gemini instead when the server has Gemini. Without Gemini it is refused (402, scope `call`).
  - Gemini is reserved on its input bound plus its output bound (`maxOutputTokens`: 4,096 tokens). The input bound is the WAV's seconds x 32 tokens a second, plus the instructions. For a recording of unknown length it is the 3-minute cap. That is reserved before Gemini's free `countTokens` uploads the recording, and the count then checks it: over 3 minutes is refused (413), and without a count Gemini isn't asked and the reservation is released at $0.
- **Settle** (`sttActual`):
  - OpenAI: the billed seconds in its usage (`{type: "duration", seconds}`), rounded up. With a token usage or none, the WAV's seconds. With neither, the full reservation.
  - Gemini: its `usageMetadata`.
  - A provider's refusal costs $0. No answer at all keeps the reservation.
  - The Ledger records at most 4 x the reservation (`OVERRUN`).
- **Known gap (v114 review; the fix is an open owner decision):** the 1,000-bytes-a-second rule is an estimate, not a ceiling. Silence in AAC, or Opus with DTX, runs far below it, so a small file can play for many minutes, and nothing the server measures bounds what OpenAI bills for a non-WAV recording. The part of a bill past 4 x the reservation is not counted against the tester, the month or the pool. Since v114 the Worker logs it: `tester call cost more than the Ledger records`, with the reserved, recorded and reported amounts.
- **Limits:** 20 recordings a minute per tester (`LI_LIMIT`, key `stt:<sub>`, checked once per request), and 2 minutes per recording in the client. On the server: 10 MB for every container; 180 s exactly for WAV (its header gives the length), and for the Gemini fallback through `countTokens`; for other containers sent to OpenAI (MP4, WebM, MP3) nothing measures the length. The 413 `too_large` text names the limit that was hit: "up to 10 MB" for the byte cap, "up to 3 minutes" only where the length was measured.
- Neither the recording nor the transcript is stored on the server.

### A8.3 Look up for testers (free, rate-limited)

- `GET /api/lookup` and `GET /api/lookup/img` are on the tester allow-list.
- Look up is free: it never calls `reserve()` and never touches the Ledger. It reaches only Wikipedia and Wikimedia Commons, from the server.
- Rate limits:
  - `LOOKUP_LIMIT`: 30 a minute per tester, key `t:<sub>`; preview images count separately on `t:<sub>:img`.
  - `WIKI_LIMIT` for Atelier's own calls to Wikimedia, with testers sharing separate keys from the owner, so testers can never use up Look up for the owner.
- A tester starts on "On tap": nothing leaves the browser until they tap Look up. The owner's default is automatic.
- Cache: Look up answers are kept in the serving data centre's edge cache (`caches.default`) for 24 h when an article was found (`ttlFound`) or 1 h when none was (`ttlMiss`), and preview images for 7 days (`IMAGE.ttl`). An answer repeats the selected phrase (`query`, up to 120 characters). The keys are SHA-256 hashes that include who asked (`owner` or `t:<sub>`) together with the phrase, the wiki language and script variant (for an image, the Commons file key), so entries are served only back to the same person. Failures are never cached. This is an exception to spec §10's "No prompts or outputs are stored on the server", alongside the per-tester profile and memory recorded under "In addition to spec §10" (A6); privacy §2 (testers) and §6 say so.

### A8.4 Runway stays owner-only

- `/api/runway/*` (Runway video) is not on the tester allow-list. The tester router answers `runway/*` with 403 `owner_only`.
- Runway has no entry in `src/tester/prices.js`, so it is never in `TESTER_VIDEO_MODELS`. The client offers a tester only the models on that list (`modelReady`), so tester mode never shows a Runway model.

### A8.5 Refused sign-in retention (refines A4)

- The last refused sign-in is kept for 7 days (`REFUSED_TTL` in `src/tester/ledger.js`). After that it is dropped on read and purged by the alarm.
