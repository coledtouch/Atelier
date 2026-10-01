# Atelier — LinkedIn tester access (design)

Date: 2026-09-30 · Status: approved in conversation, awaiting written-spec review
Owner: Cole Ciprari · Site: https://atelier.ciprari.ai

## 1. Goal

Let up to **25 people from Cole's LinkedIn** sign in with LinkedIn and try Atelier on **paid models**, under a
spending ceiling that cannot be exceeded. At the same time, nothing that belongs to the owner may be reachable
by a tester. The owner's passcode access stays exactly as it is.

**Success:**
- A stranger signs in with LinkedIn and uses chat, code, ideas, the app builder and image generation.
- They see how much allowance they have left.
- They hit a clear stop when it runs out.
- Total tester spend never passes $100 in a calendar month, and any single tester is held to their own limits.
- No tester request can reach the owner's accounts, tools, profile/memory, browser relay or diagnostics.

**Non-goals:**
- Public sign-up without LinkedIn.
- Billing testers.
- Syncing a tester's threads across devices.
- Tester use of agent tools, web search or Veo.
- A waitlist beyond a "spots are full" message.

## 2. Decisions (from Cole, 2026-09-30)

| Question | Decision |
|---|---|
| What testers use | Paid models (Claude, GPT, Gemini, …), strict caps |
| Tester cap | 25 tester spots; a revoked spot frees up |
| Money ceiling | $100 per calendar month (UTC) for all testers combined; pauses tester access when reached |
| Per tester | $1.00 per UTC day, $10.00 per calendar month |
| Enforcement | Metered in Atelier: reserve worst case before the call, settle to reported usage after; conservative price table |
| Sign-in | Sign in with LinkedIn (OpenID Connect), reusing Cole's existing LinkedIn developer app (already has `openid profile`) |
| Listing | Atelier is listed on ColeOS / résumés / LinkedIn now; "Try it: 25 LinkedIn tester spots" added at tester launch |

## 3. Current state (read-only map, 2026-09-30 ~18:15 snapshot; line numbers will drift)

- **Auth:** the only credential is `APP_PASSCODE`, sent as the `x-app-pass` header.
  - `passOk` (src/worker.js:89) gates everything: `/api/me`, `/api/diag`, `/api/tools*`, `/api/relay/{pair,status,cmd}`, and the prefixes `oauth/ accounts/ photos/ canva/` (worker.js:374).
  - `resolveKey` = provider secret AND passOk (worker.js:91-94) gates `/api/chat`, `/api/x/*` and the NVIDIA routes.
- **Owner-only surfaces:**
  - 40 agent tools across 9 services, all acting on owner accounts (src/tools.js). Tool approval is a client-sent boolean (tools.js:1549).
  - The Relay Durable Object drives the owner's logged-in browser (src/relay.js; worker.js:289-313).
  - The `me` KV key holds the owner's profile and memory.
- **Cost paths:**
  - `/api/chat`:
    - Anthropic goes through the SDK stream (src/anthropic.js). One request can bill up to 4 pause_turn rounds, one SDK retry, and web_search up to 5 uses per round.
    - OpenAI, Gemini-compat, Z.ai, DeepSeek and Meta are piped raw by `forward()` (worker.js:125).
  - `/api/x/*` passthrough (worker.js:197-211) forwards raw bodies for OpenAI/Meta images and Gemini image `generateContent`, plus Veo `predictLongRunning`, operation polls and file downloads.
  - Free NVIDIA routes share the owner's key and rate limit.
- **Budget controls:** none today. No usage is read anywhere, there is no server-side model allow-list, and `max_tokens` is clamped only for Anthropic.
- **Client:**
  - "Signed in" means `S.settings.passcode`, checked by `hasCredentials`, `providerReady`, `submit`, `loadTools`, `refreshRemote`, `pushMe` and `pullMe`.
  - Background helpers make paid calls: nameThread, enhance, planTasks, learnFrom (learnFrom also PUTs /api/me).
  - The fallback chain treats 429 as "busy" and 401/402/403 (plus quota words) as "provider dead". A 401 containing "passcode" wipes the stored passcode.
- **Tests:** `node --test tests/*.test.mjs` calls `worker.fetch(new Request(...), env)` with a fake KV and a mocked `fetch`. The DurableObject is stubbed. There is no Miniflare.
- **In-flight work by another session:** `src/gemini.js` (`/api/video/*`, Gemini native chat) is not yet wired into worker.js. It must stay owner-only (§5 covers this by default).

## 4. Architecture overview

```
browser ──► /api/li/start ──► LinkedIn OIDC ──► /api/li/callback ──► Ledger.admit() ──► Set-Cookie (tester session)
browser ──► /api/*  ──► identify(req) ─┬─ owner (passOk)      ──► existing router, unchanged
                                       ├─ tester (cookie)     ──► testerRouter (allow-list only) ──► shape ─► Ledger.reserve ─► upstream ─► settle
                                       └─ none                ──► existing behaviour (401s)
```

New units:
- **`src/tester/ledger.js`**: the `Ledger` Durable Object, single instance `"main"`, SQLite storage. Holds the roster, sessions, spend and reservations. It is the only strongly consistent state.
- **`src/tester/auth.js`**: LinkedIn OIDC start/callback, the session cookie, `identify(req, env)`.
- **`src/tester/router.js`**: the tester allow-list router plus request shaping (body rebuild and clamps).
- **`src/tester/prices.js`**: the conservative price table and cost functions (worst-case and settle).
- **`src/tester/usage.js`**: usage extraction (Anthropic final usage, SSE usage tap for OpenAI-compatible streams, image and Gemini usage).
- **Client:** tester mode in `public/app.js` (small, flag-driven changes), a sign-in button in `index.html`, and a Testers panel for the owner.

## 5. Identity, sessions and access

**Sign-in (LinkedIn OIDC):**
- `GET /api/li/start` is public. The `li/` prefix deliberately avoids the owner-gated `oauth/` prefix.
  - It creates `state` and `nonce` (32 random bytes each), stored single-use in the Ledger with a 10-minute TTL.
  - It redirects to `https://www.linkedin.com/oauth/v2/authorization` with `response_type=code`, `scope=openid profile email` and `redirect_uri=https://atelier.ciprari.ai/api/li/callback`.
  - It never requests `w_member_social`.
- `GET /api/li/callback`:
  1. Consume the state atomically in the Ledger.
  2. Exchange the code at `https://www.linkedin.com/oauth/v2/accessToken` using `LI_CLIENT_ID`/`LI_CLIENT_SECRET`.
  3. Call `https://api.linkedin.com/v2/userinfo` to get `sub`, `name`, `email`, `picture`.
  4. Call `Ledger.admit(profile)`, which returns `admitted | full | revoked | paused`.
  5. If admitted, issue a session.
  6. Redirect to `/?tester=welcome|full|revoked|paused|denied|error`.
- The LinkedIn access token is used once and never stored.

**Session:**
- A 32-byte random token in cookie `__Host-atelier_tester` (HttpOnly, Secure, SameSite=Strict, Path=/, 30 days).
- The Ledger stores only `sha256(token)` → `{sub, exp}`.
- `POST /api/li/logout` deletes the session.

**Identity:** `identify(req, env)` checks in this order:
1. If `passOk`, it's the **owner**. The owner always wins, even if a tester cookie is also present.
2. Otherwise, a valid tester cookie makes it a **tester**, looked up via the Ledger with a 60-second in-memory cache per isolate. Revocation deletes the sessions, and the cache TTL bounds any lag.
3. Otherwise, **none**.

**CSRF:** for tester requests, any non-GET must carry `Origin: https://atelier.ciprari.ai`, or `http://127.0.0.1:8787` in dev. Otherwise it gets 403.

**Deny by default:** at the top of `handleApi`, a **tester** request goes only to `testerRouter`. Anything not on its list returns `403 {code:"owner_only"}`. Routes added later, such as `/api/video/*`, are automatically unreachable for testers.

**Tester allow-list:**

| Route | Purpose | Metered |
|---|---|---|
| `GET /api/health` | boot | no |
| `GET /api/tester/me` | name, picture, allowed models, allowance left, pool state | no |
| `POST /api/li/logout` | sign out | no |
| `POST /api/chat` | chat, code, ideas, app builder | yes |
| `POST /api/x/openai/images/generations`, `/edits` | paid images (allow-listed models) | yes, per image |
| `POST /api/x/gemini/v1beta/models/<image-model>:generateContent` | Nano Banana images only (model allow-list; no tools) | yes, per image |
| `POST /api/genai/<org>/<model>`, `GET /api/status/<id>` | free NVIDIA images (FLUX), and video via Cosmos when available, else a motion still | $0, counted: 60 req/tester/day |
| `POST /api/fn/cosmos3-nano` | free NVIDIA video | $0, counted |

`GET /api/status/<id>` and any other poll are allowed only for job ids that this tester created. The Ledger records `jobs(upstream_id → sub)`.

**Refused for testers:**
- `/api/me`, `/api/diag`, `/api/tools*` and `/api/relay/*`.
- The `oauth/`, `accounts/`, `photos/` and `canva/` prefixes.
- Veo (`predictLongRunning`), `/api/video/*`, and `/api/models`.
- Any other `/api/x/*`.

## 6. Request shaping (tester requests only)

The server **rebuilds** each tester body from a field whitelist, instead of passing through what the client sent.

**Chat (`POST /api/chat`):**
- **Model:** `model` must be in `TESTER_MODELS` (server-side, from prices.js). Otherwise the request gets `403 {code:"tester_model"}`.
- **Fields kept:** `messages` (text and image parts only; at most 8 images, each at most 5 MB of base64), `temperature`, `stream`.
- **Forced:**
  - `max_tokens` = min(client value, 8192, the per-model cap). The per-model cap is the largest output whose worst-case reserve (§7) stays at or below **$0.25**.
    - This way one call never ties up more than a quarter of a tester's day, and several calls can run at once.
    - Build mode uses the same cap. When the cap is reached the reply stops early, and the tester can ask it to continue.
  - `n` = 1.
  - No `tools`, `web_search`, `reasoning_effort` above `medium`, `modalities`, or `stream_options`; the server adds its own `stream_options`.
- **Anthropic path:** pass a tester flag to `claudeChat` so it disables web_search and pause_turn continuation (one round only), caps effort at `medium` and caps `max_tokens`.
  - The model fallback (`fallbacks:'default'`) is priced at the most expensive model in its chain.
- **Request size:** at most 400 KB total, else `413 {code:"tester_too_large"}`.

**Images:**
- **Model** must be in `TESTER_IMAGE_MODELS`.
- **Counts and settings:** `n` ≤ 2, `size` from an allow-list, `quality` ≤ `medium`.
- **Gemini image requests:** reject any `tools` and `candidateCount` > 1.

**Free NVIDIA:** path allow-list for the FLUX models and cosmos3-nano, plus a per-tester daily request count.

## 7. The meter (Ledger Durable Object)

Money is stored in integer **micro-dollars**. The day key is the UTC `YYYY-MM-DD`; the month key is the UTC `YYYY-MM`.

**SQLite tables:**
- `testers(sub PK, name, email, picture, joined_at, revoked_at)`
- `spend(sub, period, spent, reserved, PK(sub, period))`, where `period` is a day key or a month key.
- `pool(month, spent, reserved)`
- `reservations(id PK, sub, amount, day, month, created_at)`
- `sessions(token_hash PK, sub, exp)`
- `oauth_state(state PK, nonce, exp)`
- `jobs(upstream_id PK, sub, created_at)`
- `config(k PK, v)`, with keys `cap=25`, `paused=0`, `day_limit=1_000_000`, `month_limit=10_000_000`, `pool_limit=100_000_000`, `nvidia_daily_requests=60`.

**Operations** (DO methods over RPC; single-threaded, so they are atomic):
- **`admit(profile)`** → `admitted` if the tester exists and isn't revoked, or if fewer than `cap` testers are active. Otherwise `full`, `revoked` or `paused`.
- **`reserve(sub, amount)`** fails if any of these would exceed its limit:
  - the tester's day (`spent + reserved + amount`);
  - the tester's month (same test);
  - the pool month (same test);
  - or the pool is paused.
  - Otherwise it writes a reservation and returns its id.
- **`settle(id, actual)`** moves the reservation to spent, recording the provider-reported actual cost, bounded at 4× the reservation (amended after review: estimates such as the bytes/3 token rule can be beaten on purpose, so an overrun is recorded in the day, month and pool totals and refuses the next reserve, instead of being absorbed).
- **`expireStale()`**, run on an alarm every 10 minutes, turns any reservation older than 15 minutes into a settle at the full reserved amount. That covers aborted streams and crashes.

**Worst case (reserve):**
- **Chat:** estimated input tokens × input price, plus `max_tokens` × output price, all × 1.25.
  - Input tokens are estimated as `ceil(bodyBytes / 3)`, plus 1,600 per image.
  - Thinking tokens bill as output and are inside `max_tokens`.
- **Images:** per-image price × n × 1.25.

**Actual (settle):**
- **Anthropic:** `final.usage` per round, including cache write/read tokens, with each model in `usage.iterations` priced separately.
- **OpenAI-compatible:** the server adds `stream_options:{include_usage:true}`. A `TransformStream` passes the SSE through unchanged and reads the final `usage`.
- **Gemini-compat:** same as OpenAI-compatible, if it reports usage. Otherwise the full reservation stands.
- **Images:** the per-image table (or `usage` when present).
- If the stream is aborted or the usage is missing, the full reservation stands.

**Price table (`prices.js`):**
- Per model: input, output, cache-write and cache-read per million tokens; images per image by size and quality.
- Sourced from the providers' pricing pages at implementation time. Anthropic prices come from the claude-api reference, never from memory.
- Rounded up, with a `checked` date in the file.
- A model missing from the table can't be used by testers.

## 8. Client (tester mode)

**Boot:**
- The client calls `GET /api/tester/me`. A 200 sets `S.tester = {name, picture, models, allowance, pool}`.
- `hasCredentials()` and `providerReady()` accept `S.tester` as a credential. Model menus show only `S.tester.models`.

**Sign-in button:**
- A "Sign in with LinkedIn — 25 tester spots" button goes in the onboarding dialog, next to the passcode field.
- It is hidden when this device already has an owner passcode: owner devices keep owner mode.
- The `?tester=` result is shown as a toast or dialog: welcome, full, revoked, paused, or error.

**Hidden and off in tester mode (UI):**
- The Connections tab, Accounts chip, Photos attach and Canva buttons/Library view.
- "Check provider keys", "Learn my style", history import, and You/memory sync.
- The browser extension and relay, and agent auto-switching.
- The helper calls nameThread, enhance, planTasks and learnFrom. Titles fall back to the first words of the prompt.
- The server still refuses all of these regardless.

**Allowance display:** remaining $ today and this month, plus pool state.
- It appears in Settings → Access, and as a compact line above the composer that stays visible at 320–480 px widths.
- It is refreshed after each metered call from the `x-tester-allowance` response header.

**Errors:**
- Tester refusals use `402` (budget) or `403` (owner_only, tester_model), always with `{error, code}`, and never contain the word "passcode".
- `ApiError` keeps `code`. `code` values starting with `tester_` bypass the fallback chain and the provider-dead marking, and render a new `budget` error kind.
- Add `budget` to `ERROR_TITLE`. It matches the data-safety errorKind rule `/^[a-z]{1,20}$/`.

**Sign out:** in Settings → Access; calls `POST /api/li/logout`.

## 9. Owner controls

Owner-only (passOk) endpoints:
- `GET /api/testers`: roster with today/month spend, pool state and config.
- `POST /api/testers/revoke {sub}`: sets `revoked_at` and deletes the tester's sessions.
- `POST /api/testers/restore {sub}`.
- `POST /api/testers/config {cap?, paused?, day_limit?, month_limit?, pool_limit?}`: limits are validated, and the pool limit can't go above $1,000 without a code change.

**UI:** Settings → Access → **Testers** (owner only). Shows the pool bar and each tester with photo, name, joined date, today and month spend, and a revoke/restore button. It also has the cap field and the pause-all switch.

## 10. Privacy and terms

- Update `privacy.html` and `tos.html`:
  - Sign-in is available to LinkedIn testers by invitation, with limited spots.
  - **Data kept:** LinkedIn id, name, email and photo, plus a usage ledger of cost per call. No prompts or outputs are stored on the server.
  - Threads stay on the tester's device.
  - Prompts go to the selected model provider.
  - **Retention:** tester records are deleted 90 days after last use, or on request to cole@ciprari.ai.
- Fix the existing mismatches the map found: "Erase everything" vs the "Clear this device" button, and "sent (to Gemini)".

## 11. Testing

Uses node:test in the existing style, with `worker.fetch` plus fakes. A small in-memory fake stands in for the Ledger DO and implements the same RPC surface. The Ledger logic itself is unit-tested against the real class with an in-memory SQL shim.

1. **Deny-by-default sweep:**
   - Every route in worker.js, plus the prefixes, called with a tester cookie, returns 403 `owner_only`, except the allow-list.
   - With both a passcode and a cookie, the owner path is taken.
2. **Shaping:** tool, web_search, n, oversized max_tokens and unknown model are stripped or rejected. Gemini `tools` are rejected. Veo is rejected.
3. **Ledger:**
   - Reserve is refused at each limit (day, month, pool, paused).
   - Settle records the reported actual, bounded at 4× the reservation.
   - Stale reservations expire at the full amount.
   - Concurrent reserves never exceed the pool (interleaved calls).
   - Cap admission: the 26th person is refused, a revoked tester is refused, and a restored tester is admitted.
4. **OIDC:**
   - State is single-use.
   - A wrong state is refused.
   - Callback outcomes (mocked LinkedIn token and userinfo): admitted, full and error.
   - The cookie has the correct attributes, and `w_member_social` is never requested.
5. **Usage taps:**
   - The Anthropic usage sum across iterations.
   - The OpenAI SSE final-usage chunk is parsed and the stream passes through byte-identical.
   - A missing usage chunk keeps the full reservation.
6. **Owner regression:** the existing 14 tests pass unchanged, and owner calls are never metered.
7. **Browser checks:**
   - The review fixture (`npm run review:ui`) gets a tester fixture: sign-in button, tester mode UI, allowance line at 320/390/1440 px, budget error card, and no owner surfaces visible.

## 12. Rollout

1. **Wait** for the in-flight "Atelier PWA UI/UX polish" session to finish. Then `git init` the folder and commit a full snapshot (with .dev.vars, .wrangler and node_modules ignored) before any change.
2. **Implement** on a branch; run the tests and the review fixture.
3. **Cole:**
   - In the existing LinkedIn developer app, under **Auth → Authorized redirect URLs**, add `https://atelier.ciprari.ai/api/li/callback`.
   - In the Atelier folder, run `npx wrangler secret put LI_CLIENT_ID` and `npx wrangler secret put LI_CLIENT_SECRET`, pasting the values from that app.
4. **Deploy with `paused=1`** (this adds the Ledger DO migration `v2`). Cole signs in as a tester from a private window, sanity-checks a few calls and watches the ledger. Then he unpauses.
5. **Add "Try it"** ("Try it: 25 LinkedIn tester spots") to the ColeOS listing, the résumé and the LinkedIn project.

## 12a. Amendment (2026-09-30): preview testers while paused

As originally written, §12 step 4 couldn't work: with `paused=1`, `admit()` refuses everyone and `reserve()` fails, so nobody could sign in or make a call to test. The fix:

- **Config:** add `preview_subs`, a JSON array of LinkedIn subs, default `[]`. Only the owner sets it, via `POST /api/testers/config`.
- **While paused:** `admit()` and `reserve()` refuse everyone except subs listed in `preview_subs`. Preview subs are still held to their own daily and monthly limits and to the pool limit.
- **Finding your sub:** the owner Testers panel shows the most recently refused sub, so Cole can sign in once, get refused, and add himself.
- **Secret names:** as set by Cole, they are `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET`, replacing `LI_CLIENT_ID` and `LI_CLIENT_SECRET` everywhere in this spec.
- **Rollout step 4 becomes:**
  1. Deploy paused.
  2. Cole signs in once; he is refused and his sub is shown in the Testers panel.
  3. He adds his sub to `preview_subs`.
  4. He tests while the independent review runs.
  5. He unpauses.

## 13. Risks and open items

- **Another session is editing the same files right now.** Re-map line numbers at implementation time. Deny-by-default keeps any newly wired route (for example `/api/video/*`) owner-only.
- **Price table drift:** the 1.25× margin, reserve-as-ceiling and the `checked` date mitigate it. Re-check prices when adding models.
- **Gemini's OpenAI-compatible stream may not report usage.** If it doesn't, Gemini calls settle at the full reservation. That is safe, but spends allowance faster; accept it or switch testers to the native adapter later.
- **Consent screen:** it shows the existing LinkedIn app's name and logo. Rename that app to something neutral (for example "Ciprari.AI") if it reads oddly.
- **NVIDIA:** free routes still use the owner's NVIDIA quota. The per-tester daily request count bounds it.
