# Atelier — LinkedIn tester access: owner addendum

Date: 2026-09-30 · Applies on top of `2026-09-30-atelier-tester-access-design.md` (the "spec").
Wherever this addendum and the spec disagree, the addendum wins. Everything not mentioned here stays as the spec says.

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
- **Tester full-clip limits:** 200 MB and 180 s. Larger clips go as frames; the client already falls back.
- **Metering:** chats carrying video parts are metered like any chat.
  - The worst-case reserve adds video and audio tokens from the file duration: Gemini file `videoMetadata`, else the 180 s cap. Use about 300 tokens/s video and 32 tokens/s audio, or the current documented rates.
  - Settle from `usageMetadata` of the native `streamGenerateContent` stream.

Video mode:
- Free NVIDIA Cosmos and the motion still stay as in the spec (free, counted per day).
- Veo is allowed:
  - `predictLongRunning` for the allow-listed `veo-*` models only.
  - One video per request, 8 s max, no tools.
  - Reserve = seconds × per-second price × 1.25.
  - Operation polls and file downloads only for operations this tester created.

## A3. Feature-rich tester mode (owner decision: "I want it feature rich")

This replaces the spec's §8 "Hidden and off in tester mode" list. Everything below is metered by the Ledger under the same limits: $1 per day and $10 per month per tester, and the $100 monthly pool.

- **Helpers ON:** `nameThread`, `enhance`, `planTasks` and `learnFrom` run for testers, each as its own metered call on the fast or helper models.
- **Web search ON:** Anthropic `web_search` with `max_uses: 3` per round.
  - pause_turn continuation stays limited to 1 round.
  - The search fee (per the claude-api reference) is included in the reserve.
- **Reasoning:** `reasoning_effort` up to `high` is allowed; `max_tokens` still bounds the reserve.
- **Images:** `n` up to 4, reserved per image. Edits and variations are allowed on allow-listed image models.
- **Per-tester "You":**
  - Profile, bio, writing style, memory and learned facts are stored server-side per LinkedIn `sub`, in the Ledger DO or KV key `me:t:<sub>`. They are never in the owner's `me` key.
  - Tester routes: `GET/PUT /api/tester/profile`, with a size cap such as 300 KB.
  - "Learn my style" and history-import analysis are metered.
  - The profile is deleted together with the tester record.
- **Client-side features unchanged for testers:** Library, viewer, downloads, the device read-aloud voice, the browser's own speech recognition for dictation, and thread export/import.
  - The AI Read aloud voices (`POST /api/tts`), server dictation (`POST /api/transcribe`) and Look up (`GET /api/lookup`, `/api/lookup/img`) are tester routes too: see A8.

Public before identity (dispatched in `src/worker.js` before `identify()`, so neither the passcode nor a tester session decides them; `PUBLIC_PATHS` in `src/tester/router.js`). A request carrying `x-app-pass` still passes the passcode lockout guard first (`passcodeGuard`: it reads the per-IP KV failure counter, adds to it on a wrong passcode, and answers 429 once that IP is locked out). Browsers never send that header with a CSP report, and the app's own health check and sign-in calls don't send it either, so in practice it has no effect on these routes:
- `GET /api/health`, and the LinkedIn sign-in routes `/api/li/*` (spec).
- `POST /api/csp-report`: Content-Security-Policy violation reports from browsers (`public/_headers` report-uri / report-to).
  - Only `application/csp-report` or `application/reports+json` bodies (case-insensitive, parameters allowed); any other content type gets 415 and logs nothing.
  - Each report becomes one PII-free log line (directive, blocked origin, page and source as origin + path, line, column, disposition); no IP, user agent, query string, sample or cookie. Fields are read only as strings or finite numbers, so a hostile body can't throw.
  - Throttled per IP (`LI_LIMIT`, key `csp:<ip>`) and per isolate (60 lines a minute); never touches the Ledger or a tester record, and touches KV only through the passcode lockout guard above, when a request carries `x-app-pass`.
- `GET /api/relay/ws`: the browser extension's WebSocket. The Relay authenticates it only by its device-token subprotocol, so it is dispatched before `identify()` (a tester cookie in the owner's browser can't turn the extension away). Testers and anonymous callers get the Relay's own 426 / 401, never a socket. The rest of `/api/relay/*` stays owner-only.

Still owner-only (deny by default):
- `/api/me` (the owner profile), `/api/diag`, `/api/models`, `/api/tools*` and `/api/relay/*` (except `relay/ws`, above), plus the browser extension.
- `/api/runway/*` (Runway video, A8).
- The `oauth/`, `accounts/`, `photos/` and `canva/` prefixes. Testers cannot connect their own Canva until the Canva app passes Canva's review.
- `/api/testers*` admin routes, and any route not on the tester allow-list.

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
  - Veo reserve
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
  - Tester images come from GPT Image / Nano Banana, and tester video from Veo, all metered.
  - In tester mode the client hides the motion-still and NVIDIA options. Fallback chains skip NVIDIA, so they never end on a model the tester can't use.
- **Per-call chat cap stays $0.25, with exceptions:**
  - Web-search calls get a $0.50 cap.
  - Tester web calls run with Anthropic fallbacks off, and `max_uses` is the largest of 3, 2 or 1 that fits.
  - If not even 1 fits on the chosen model, that call uses Sonnet 5.5, and the meta line notes it.
- **Veo for testers:** a call is admitted only if its worst case fits the tester's remaining day, month and pool, and never above $1.00.
  - The client offers only durations and resolutions that fit, and explains when one doesn't.
  - Veo standard (`veo-3.1-generate-preview`) is excluded for testers; prices.js already marks it so.
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

- **Route:** `POST /api/tts` on the tester allow-list (`src/tester/router.js`); `src/tts.js` validates the body and calls the provider, the router reserves and settles.
  - Voices: `atelier`, `cedar` and `sage` (OpenAI `gpt-4o-mini-tts-2025-12-15`), and `sulafat` (Gemini `gemini-3.8-flash-lite-tts`), each only while it is in `TESTER_TTS_MODELS` and its provider key is on the server.
  - The client sends only `{voice, text}` or `{voice, preview: true}`. The server adds the voice brief or style.
- **Limits:**
  - At most 1,000 spoken units per request (`TTS_LIMITS.testerChars`, counted by `spokenUnits`: plain prose is one unit per character, digits and CJK characters weigh more). The client segments longer answers.
  - A 16 KB request body (`TTS_LIMITS.bodyBytes`).
  - 20 requests a minute per tester (`LI_LIMIT`, key `tts:<sub>`); past it, 429 `tts_busy` with `retry-after: 30`.
- **Reservation:** priced on the ceiling units (`ttsCeilingUnits`: symbols, emoji and CJK read as words), not on the spoken units.
  - `ttsWorstCase`: `ceil(units / 8)` reserved seconds x the model's reserve rate in audio tokens per second at the audio rate, plus `ceil(units / 3) + 200` input tokens, x the 1.25 margin.
    - OpenAI: 50 tokens/s, an assumption.
    - Gemini: 32 tokens/s (`reserveTokensPerSecond`). Google publishes 25 tokens/s, but the live owner read logged about 31.8 tokens/s for Sulafat. Reserving at 25 tokens/s set `maxOutputTokens` too low, so slow reads stopped early at `MAX_TOKENS`. The settle still uses 25 tokens/s as its floor (see Settle).
  - Refused above the $0.25 per-call cap (`PER_CALL_RESERVE_CAP`).
- **Bounds:**
  - OpenAI speech has no output bound, so the stream is cut off once its audio (timed from the mp3 frame headers) plays past `TTS_CUTOFF_FACTOR` (2) x the reserved seconds + 1.
  - Gemini is bounded at the source: `maxOutputTokens` is the reserved audio tokens.
- **Settle:**
  - Refused by the provider before any audio: $0.
  - Finished: the provider's report.
    - OpenAI: the `speech.audio.done` usage.
    - Gemini: max(reported output tokens, seconds returned x 25 tokens/s), all priced at the audio rate. The live owner test logged about 31.8 audio tokens/s for Sulafat, so the reported count usually wins. `maxOutputTokens` is the reserved audio tokens, so the reported count can't pass them. The seconds estimate is capped at the same bound (`ttsActual` `maxAudioTokens`). The reservation therefore stays a true ceiling.
  - A stream that stops (cut off, hung up or broken) after the provider reported usage: max(reservation, reported).
    - OpenAI sends usage only in `speech.audio.done`, its last event, so a reported usage is the complete bill. The timed seconds are then not used: `src/tts.js` sends them only with no usage, and `ttsActual` ignores them when usage is present. This holds even when the cut-off lands in the same chunk as `speech.audio.done`.
  - An OpenAI stream that stops (cut off, hung up or broken) before any usage arrives: max(reservation, the seconds the cut-off clock timed x 50 tokens/s at the audio rate + input estimated from the characters). The cut-off bounds what the tester hears; this settle bounds what is billed.
  - A hang-up with no usage and no audio timed: the full reservation stands.
- **When the allowance is out**, or a passage would take too long to say in one request, the client reads with the device voice (`speechSynthesis`), which sends nothing to Atelier.
- **Privacy:** the text read aloud goes to OpenAI, or to Google for Sulafat (privacy page §5). Clips are cached only on the device (browser Cache Storage, about 30 MB / 200 clips), cleared by Clear this device or a tester sign-out. The ToS states the typical price and the rate limit.

### A8.2 Dictation for testers (metered)

- `POST /api/transcribe` is on the tester allow-list. The client uses it only where the browser can't transcribe speech itself (iPhone and iPad, for example). Elsewhere the browser's own speech recognition runs first and touches no allowance.
- Metered like any paid call:
  - OpenAI `gpt-4o-mini-transcribe-2025-12-15` is reserved on its whole context window plus its output cap (`sttWorstCase`, about $0.0375 with the margin).
  - The Gemini fallback (`gemini-3.5-flash-lite`) is reserved on the WAV's seconds, or the 3-minute cap, plus its output bound.
  - Each provider that runs is reserved and settled on its own, and a provider's refusal costs $0.
- Limits: 20 recordings a minute per tester (`LI_LIMIT`, key `stt:<sub>`, checked once per request), 10 MB and 180 s on the server, and 2 minutes per recording in the client.
- Neither the recording nor the transcript is stored on the server.

### A8.3 Look up for testers (free, rate-limited)

- `GET /api/lookup` and `GET /api/lookup/img` are on the tester allow-list.
- Look up is free: it never calls `reserve()` and never touches the Ledger. It reaches only Wikipedia and Wikimedia Commons, from the server.
- Rate limits:
  - `LOOKUP_LIMIT`: 30 a minute per tester, key `t:<sub>`; preview images count separately on `t:<sub>:img`.
  - `WIKI_LIMIT` for Atelier's own calls to Wikimedia, with testers sharing separate keys from the owner, so testers can never use up Look up for the owner.
- A tester starts on "On tap": nothing leaves the browser until they tap Look up. The owner's default is automatic.

### A8.4 Runway stays owner-only

- `/api/runway/*` (Runway video) is not on the tester allow-list. The tester router answers `runway/*` with 403 `owner_only`.
- Runway has no entry in `src/tester/prices.js`, so it is never in `TESTER_VIDEO_MODELS`. The client offers a tester only the models on that list (`modelReady`), so tester mode never shows a Runway model.

### A8.5 Refused sign-in retention (refines A4)

- The last refused sign-in is kept for 7 days (`REFUSED_TTL` in `src/tester/ledger.js`). After that it is dropped on read and purged by the alarm.
