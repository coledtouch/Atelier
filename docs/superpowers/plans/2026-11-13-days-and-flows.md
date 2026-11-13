# Days and Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atelier opens on a Today page where the day's flows (tagged threads) live side by side, carry over across days, and keep their own context and composer choices.

**Architecture:** A flow is an existing thread record plus a synced `flow: {kind, color?}` field and a local-only `opts` field. Days are derived from entry times by a new pure module `public/days.js`. Sync gains `flow`/`flowRev`, mirroring `title`/`titleRev`. The UI adds a Today view (flow tabs, an All timeline, a composer flow picker) in front of the existing conversation view.

**Tech Stack:** Vanilla JS PWA (`public/app.js`, CRLF), Cloudflare Worker (`src/sync.js`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-13-days-and-flows-design.md`

## Global Constraints

- App copy: no sentence over 16 words, no banned humanizer words (`tests/humanizer-copy.test.mjs` lints `index.html` and client strings).
- `public/app.js` keeps CRLF line endings.
- Every new client module is added to `npm run check` in `package.json` and imported with `?v=<build>`.
- Sync stays FORMAT 1. Old documents and old clients (v131) keep working both ways.
- Version bump with `node scripts/bump-version.mjs 132` (sw.js VERSION and every `?v=`).
- Never junction `node_modules`. No push or deploy.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A turn sent at 23:58 whose answer lands after midnight stays on the day it was asked; DST days still split on local midnight. → Task 1 test `dayKey across midnight and DST`.
2. Two devices set different kinds on one flow at once: one wins by `flowRev` base, the other adopts it on pull, no ping-pong. → Task 3 test `concurrent flow changes settle on one`.
3. A v131 device pushes entries to a flow a new device tagged: the tag survives. → Task 3 test `old-shape push keeps flow`.
4. A past day's flow gets a new turn: it shows in Today's tabs, and its old day still lists it. → Task 1 test `carry-over puts a flow on both days`.
5. `+ Flow` then leaving without sending leaves no empty flow behind, and a flow tag alone on an entry-less thread never pushes. → Task 3 test `flow on an empty thread does not push`; Task 6 fixture check.

---

### Task 1: `public/days.js` pure module

**Files:**
- Create: `public/days.js`
- Test: `tests/days.test.mjs`
- Modify: `package.json` (add `node --check public/days.js` to `check`)

**Interfaces:**
- Consumes: `GROUP_SETS`, `groupsFor` from `public/thread-spaces.js` (Task 2 adds kinds; write against Task 2's keys).
- Produces:
  - `dayKey(ms: number) → 'YYYY-MM-DD'` (local date)
  - `entryTime(e) → number` = `e.at ?? e.createdAt`
  - `flowDays(thread) → Set<string>`; an entry-less thread → `{dayKey(thread.createdAt)}`
  - `flowsOn(threads, day) → thread[]`, ordered by latest entry time on that day, newest first
  - `daySlice(thread, day) → { earlier: number, entries: entry[] }` (entries on `day`; `earlier` = count of the rest before the first of them)
  - `dayTimeline(threads, day) → [{ thread, entry, at }]`, ascending by `at`
  - `dayList(threads) → [{ day, ids: string[] }]`, newest day first
  - `stepDay(days: string[], day, dir: -1 | 1) → string | null`, nearest day with entries
  - `kindOf(thread, guesses) → string` = `thread.flow?.kind` else `spaceOf(guesses, thread.id)` else `''`
  - `cleanFlow(v) → { kind, color? } | null` (kind string ≤ 24 of `[a-z0-9-]`, color ≤ 16)
  - `flowHint(kind, set) → string`: `` (label from the set; `''` for unknown)
  - `KIND_DEFAULTS: { linkedin: { mode: 'ask', ask: { voice: true } } }`, others `{ mode: 'ask' }`

- [ ] **Step 1: Write failing tests** in `tests/days.test.mjs`. Run with `TZ=America/New_York`-independent fixtures built from `new Date(y, m, d, h, min).getTime()`:
  - `dayKey across midnight and DST`: 23:58 Nov 12 → `'2026-11-12'`; 00:01 Nov 13 → `'2026-11-13'`; 00:30 Mar 8 2026 and 03:30 Mar 8 2026 → same key.
  - `entryTime prefers at`: `{createdAt: A, at: B}` → B; `{createdAt: A}` → A.
  - `carry-over puts a flow on both days`: entries on Nov 11 and Nov 13 → `flowDays` has both; `flowsOn([t], '2026-11-13')` includes t; `daySlice(t, '2026-11-13')` → `{ earlier: 1, entries: [second] }`.
  - `empty flow lives on its creation day`.
  - `flowsOn orders by latest activity that day`.
  - `dayTimeline interleaves flows by time`.
  - `dayList newest first, each day once`.
  - `stepDay skips empty days and stops at the ends` (returns null past the ends).
  - `kindOf prefers the synced kind over the guess`: `{flow:{kind:'kid'}}` with guess `'coen!'` → `'kid'`.
  - `cleanFlow rejects junk`: `null`, `{}`, `{kind: 'x'.repeat(25)}`, `{kind: 'A B'}` → null; `{kind:'kid', color:'x'.repeat(17)}` → `{kind:'kid'}`.
  - `flowHint names the kind`: owner set, `'coen'` → `'This flow is about Work: Coen Construction.'`; unknown kind → `''`.
- [ ] **Step 2: Run** `node --test tests/days.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** `public/days.js` with the exports above. No DOM, no network. Local date via `getFullYear/getMonth/getDate`, zero-padded.
- [ ] **Step 4: Run** `node --test tests/days.test.mjs` → PASS; `npm run check` → no output errors.
- [ ] **Step 5: Commit** `feat(days): pure day and flow helpers`.

### Task 2: Flow kinds in `thread-spaces.js`, owner answers carried forward

**Files:**
- Modify: `public/thread-spaces.js`
- Modify: `public/app.js` (where `threadSpaces` is loaded from localStorage by set id; find with `grep -n "threadSpaces" public/app.js`)
- Test: `tests/thread-spaces.test.mjs`

**Interfaces:**
- Produces:
  - `GROUP_SETS.owner.id === 'owner2'`, groups in order `personal, kid, coen, edgeball, work, linkedin, apps`.
  - `GROUP_SETS.basic.id === 'basic2'`, groups `work, personal, kid, linkedin`.
  - Every group gains `color` (a CSS custom property name, e.g. `'--flow-coen'`).
  - `PREVIOUS_SET_IDS = { owner2: 'owner1', basic2: 'basic1' }`
  - `carryForward(oldRaw, set) → spaces` = `cleanSpaces(oldRaw, set)` (old keys are a subset, so answers and `!` marks survive).
- Hints for the new groups: `kid`: "their child: school, homework, activities, gifts, health and things to do together." `linkedin`: "posts, comments and messages for their LinkedIn, written in their voice."

- [ ] **Step 1: Write failing tests:** `owner2 keeps owner1 answers and hand marks` (`{a:'coen!', b:'apps'}` → same); `owner2 sorts into kid and linkedin` (`parseSpaces('1: kid\n2: linkedin', 2, owner)` → `['kid','linkedin']`); `basic2 has four groups`. Update existing tests that assert `owner1`/`basic1` ids or group counts.
- [ ] **Step 2: Run** `node --test tests/thread-spaces.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the sets, `PREVIOUS_SET_IDS`, `carryForward`. In `app.js`, when the store for the current set id is empty and the previous set's store exists, load it through `carryForward` and save under the new id.
- [ ] **Step 4: Run** `node --test tests/thread-spaces.test.mjs tests/days.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(days): kid and LinkedIn flow kinds; keep earlier sorting`.

### Task 3: Sync core: `flow` / `flowRev` in `sync-merge.js` and `src/sync.js`

**Files:**
- Modify: `public/sync-merge.js` (`newDoc` ~386, `checkPush` ~342, `checkView` ~365, `docView` ~406, `applyPush` ~423, `applyDelete` ~475, `applyRestore` ~492, `newRecord` ~514, pull planning ~733-747, `planPush` ~768-809, `pushBodies` ~814, `applyPlan` ~965)
- Modify: `src/sync.js` only if it builds responses or views outside these helpers (check `grep -n "title" src/sync.js`)
- Test: `tests/sync-merge.test.mjs`, `tests/sync-worker.test.mjs`

**Interfaces:**
- Consumes: `cleanFlow` semantics from Task 1 (duplicate as `validFlow(v)` inside `sync-merge.js`: sync-merge imports nothing app-side).
- Produces:
  - Document: `flow: {kind, color?} | null`, `flowRev: number` (missing on old documents = `null` / `0`).
  - Push body: optional `flow: { v: {kind,color?} | null, base: number }`; response gains `flow: { v, rev }`.
  - View: `flow`, `flowRev` (only when the doc has them; `checkView` accepts absent or valid).
  - Record (`t:<id>`): `flow` (`undefined` = never synced), `flowRev`.
  - Pull plan: `plan.flow` (`undefined` = no change) and `plan.localFlow`; `applyPlan` returns `{ok:false}` when `canonical(thread.flow ?? null) !== canonical(plan.localFlow ?? null)` and sets `thread.flow` when `plan.flow !== undefined`.
  - Push plan: `out.flow = { v, base }` under the same rule as title (only once the thread has entries or `base.rev > 0`).
- Rules: apply when `base === doc.flowRev && !foreign`, or when the stored flow is null and the pushed one is not. `applyDelete` to a tombstone sets `flow = null`, `flowRev += 1` when it was set. `applyRestore` brings back `snap.flow` when the current one is null.

- [ ] **Step 1: Write failing tests** in `tests/sync-merge.test.mjs`:
  - `push sets flow on a new doc` and `checkPush rejects a bad flow` (`{v:{kind:'A B'},base:0}` → `bad_shape`).
  - `old-shape push keeps flow` (a body with no `flow` leaves `doc.flow`/`flowRev` unchanged).
  - `concurrent flow changes settle on one`: device A pushes `kid` base 0 → rev 1; device B pushes `coen` base 0 → not applied, response `flow.v.kind === 'kid'`; B's pull plan adopts `kid`.
  - `checkView accepts a doc without flow and one with flow`; `checkView rejects a bad flow`.
  - `flow on an empty thread does not push`: thread with `flow` and no entries, fresh record → `planPush(...).flow === null` and `dirty === false`.
  - `applyPlan refuses when local flow moved` and `applyPlan applies a pulled flow`.
  - `tombstone clears flow`; `restore brings flow back`.
  In `tests/sync-worker.test.mjs`: `worker round-trips flow` (push with flow, GET view has it), against `tests/fake-r2.mjs`.
- [ ] **Step 2: Run** `node --test tests/sync-merge.test.mjs tests/sync-worker.test.mjs` → new tests FAIL, old ones PASS.
- [ ] **Step 3: Implement** per the Interfaces block, mirroring each title code path.
- [ ] **Step 4: Run** `node --test tests/sync-merge.test.mjs tests/sync-worker.test.mjs tests/sync-sim.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(sync): flow tag syncs like the title`.

### Task 4: Sync client engine: detect and keep `flow`

**Files:**
- Modify: `public/sync.js` (dirty flag ~1768, `maybeChanged` ~2077, open-tab merge ~693, `patchInPlace` ~373)
- Test: `tests/sync-client.test.mjs`, `tests/sync-sim.test.mjs`

**Interfaces:**
- Consumes: Task 3's push/pull plan fields.
- Produces: `patchInPlace(target, source, take, drop, { title, flow, ... })` copies `source.flow` when `flow` is true; open-tab merge computes `flow` like `title` (three-way against the base snapshot).

- [ ] **Step 1: Write failing tests:**
  - `sync-client`: `changing only the flow marks the thread dirty and pushes it`.
  - `sync-client`: `a pulled flow reaches the open tab without losing a local edit` (open thread has a new local entry; remote changes flow; after merge the tab has both).
  - `sync-sim`: `two devices, one v131-shaped, keep the flow` (simulate the old client by stripping `flow` from its pushes).
- [ ] **Step 2: Run** `node --test tests/sync-client.test.mjs tests/sync-sim.test.mjs` → new tests FAIL.
- [ ] **Step 3: Implement** the four spots.
- [ ] **Step 4: Run** `node --test tests/sync-*.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(sync): the engine pushes and merges flow changes`.

### Task 5: Flow plumbing in `app.js`

**Files:**
- Modify: `public/app.js`: `newThread` (~622), `persist` (~633), `submit` (~2184), entry act `retry` (~3631), `runPrompt` (~2444), `setMode` (~3825), the options save path (`LS.set('opts', …)`; find with grep), `startFresh` (~7615), boot resume (~7969), `OWNER_LS_KEEP` (~6257)
- Test: `tests/days-app.test.mjs` (source-level checks in the style of `tests/app-v114.test.mjs`)

**Interfaces:**
- Consumes: Task 1 (`cleanFlow`, `KIND_DEFAULTS`, `flowHint`, `kindOf`), Task 2 (`groupsFor`).
- Produces (in `app.js`):
  - `newThread(flow = null)` → record with `flow` when given.
  - `openFlowOpts(thread)`: loads `thread.opts` (else `KIND_DEFAULTS[kind]` over the current `S.opts`) into `S.opts` and `S.mode`.
  - `saveFlowOpts()`: writes `structuredClone(S.opts)` + `mode` into `S.thread.opts` and calls `persist()`; called wherever `S.opts` or `S.mode` is saved today. Global `LS 'opts'` keeps the last choice for new flows.
  - `setFlow(thread, kind)`: sets `thread.flow = cleanFlow({kind})`, persists, redraws tabs.
  - Retry stamps `e.at = Date.now()` before `run(e)`.
  - `runPrompt` appends `flowHint(kindOf(thread, threadSpaces), GROUPS)` as one line when non-empty. Keep it after the static part so cached prefixes stay stable per flow.
  - `lastThread` → `lastFlow` (read the old key once as a fallback; add `lastFlow` to `OWNER_LS_KEEP`).

- [ ] **Step 1: Write failing tests** (`tests/days-app.test.mjs`, reading `public/app.js` as text and importing pure helpers): `retry stamps at`, `runPrompt adds the flow hint line`, `opts are saved per flow` (the save path calls `saveFlowOpts`), `lastFlow is kept for the owner`.
- [ ] **Step 2: Run** `node --test tests/days-app.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the Produces list.
- [ ] **Step 4: Run** `npm run check && node --test tests/days-app.test.mjs tests/humanizer-copy.test.mjs tests/context.test.mjs` → PASS.
- [ ] **Step 5: Commit** `feat(days): flows keep their own kind and composer choices`.

### Task 6: Today page, flow tabs, All timeline, composer flow picker

**Files:**
- Modify: `public/index.html` (`#stage` ~449: add `<nav id="dayBar">` with date button, ◀ ▶, search button, and `<div id="flowTabs" role="tablist">` above `#welcome`; composer ~485: add `<button id="flowPick">` at the front of the controls)
- Modify: `public/app.js` (new `renderDay()`, `renderFlowTabs()`, `renderTimeline()`, `openFlow(id)`, `newFlow()`; `renderThread` gains the "Earlier in this flow · N" bar from `daySlice`)
- Modify: `public/studio.css` (flow chip colours as `--flow-<kind>` tokens for light and dark; tabs scroll sideways under 640px)
- Test: `tests/days-app.test.mjs`, `tests/humanizer-copy.test.mjs` (lints new copy automatically)

**Interfaces:**
- Consumes: Task 1 (`flowsOn`, `dayTimeline`, `daySlice`, `dayKey`), Task 5 (`newThread(flow)`, `openFlowOpts`, `setFlow`).
- Produces: `S.day` (the day key shown, default `dayKey(Date.now())`), `S.view` (`'all'` or a thread id). `renderDay()` redraws tabs, timeline or flow. Tapping a timeline row → `openFlow(thread.id)` and scrolls to the entry.
- Copy (fixed): tab `All`; button `+ Flow`; picker label `In:`; earlier bar `Earlier in this flow · N`; empty Today `Nothing yet today. Ask anything below.`
- `newFlow()` makes an unsaved `newThread()` (persist already skips entry-less threads); the first sent prompt's title call also returns a kind guess, applied with `setFlow` unless he already picked one.

- [ ] **Step 1: Write failing tests:** `index.html has the day bar, flow tabs and flow picker`; `the All view never sends` (`submit` with `S.view === 'all'` uses the picked flow, never a merged thread); `new copy passes the humanizer lint`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check && npm test` → PASS. Then on the fixture: `preview_start {name: 'atelier-review'}`; at desktop and `mobile` sizes check: Today shows; two flows send to separate threads; All lists both in time order; switching flow restores that flow's model; `+ Flow` then switching away leaves no empty tab. Screenshot each.
- [ ] **Step 5: Commit** `feat(days): Today page with flows and an All timeline`.

### Task 7: Day navigation, Days list, search by day, boot opens Today

**Files:**
- Modify: `public/app.js` (boot ~7969, `renderThreads` ~5256, `THREAD_SORTS` ~5210), `public/index.html` (Threads drawer ~521 title becomes `Days`)
- Test: `tests/days-app.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`dayList`, `stepDay`), Task 6 (`renderDay`, `S.day`).
- Produces: ◀ ▶ call `stepDay`; the date button opens the drawer in a new default sort `days` (headings are dates, rows are flows with kind chips; the other sorts stay). Search filters as today and keeps day headings. Boot: `S.day = today`; if `lastFlow` has an entry today, `S.view = lastFlow`, else `'all'`. A launch (share, Shortcut) still goes straight to the composer.
- Sending in a past day's flow sets `S.day` to today after the send.

- [ ] **Step 1: Write failing tests:** `boot opens Today`, `the drawer defaults to Days`, `sending from a past day returns to today`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; fixture check of ◀ ▶, the Days drawer, search, and a send from yesterday landing on today (desktop and mobile).
- [ ] **Step 5: Commit** `feat(days): browse and search days; open on Today`.

### Task 8: Migration of existing threads

**Files:**
- Modify: `public/app.js` (`sortIntoSpaces` and its caller; the flow tab menu)
- Test: `tests/days-app.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`carryForward`, hand marks), Task 5 (`setFlow`).
- Produces: on first load of v132, every thread whose sorter answer ends in `!` and has no `flow` gets `setFlow(thread, key)` (once; flag `LS 'flowsMigrated'` per workspace). Opening a past day runs the existing batch sorter on that day's unsorted threads; guesses stay local. A guess becomes `flow` when he picks it in the flow menu or sends a turn in that flow. The flow tab menu offers every kind of the set plus Rename.

- [ ] **Step 1: Write failing tests:** `hand choices become synced flows once`, `a guess is not written until a send`, `a send writes the guess`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`; fixture check with seeded old-shape threads (no `flow`): they appear on their days with guessed chips and nothing is lost (entry counts match before and after).
- [ ] **Step 5: Commit** `feat(days): bring existing threads into days and flows`.

### Task 9: Version and final verification

**Files:** `public/sw.js`, `public/index.html`, `public/app.js` and every `?v=` (via the script).

- [ ] **Step 1:** `node scripts/bump-version.mjs 132`.
- [ ] **Step 2:** `npm run check && npm test` → all PASS.
- [ ] **Step 3:** Fixture walk-through on `atelier-review` (desktop and mobile): the Review Focus items 1-5 where visible, plus dark mode. Screenshots.
- [ ] **Step 4:** Commit `v132: days and flows`. Leave a hand-over note in the shared notes folder. No push, no deploy.
