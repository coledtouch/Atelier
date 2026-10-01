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
- **Client-side features unchanged for testers:** Library, viewer, downloads, dictation, read-aloud, and thread export/import.

Still owner-only (deny by default):
- `/api/me` (the owner profile), `/api/diag`, `/api/models`, `/api/tools*` and `/api/relay/*`, plus the browser extension.
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

## A7. Order

1. Ship the in-flight video-upload release and the hardening pass.
2. `git init` and commit a full snapshot, ignoring `.dev.vars`, `.wrangler` and `node_modules`.
3. Implement the spec plus this addendum.
4. Deploy with `paused=1`.
