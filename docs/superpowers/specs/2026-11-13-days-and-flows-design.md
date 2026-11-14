# Days and Flows: Atelier as a daily scratch-pad

Status: draft for approval · Branch `claude/atelier-days` (from `origin/master`, v131)

## Intent

The owner's words: instead of threads, make Atelier about actual days. Everything he asks
on a given day, personal and business, happens in that day's session. Every model, tool,
account and web search can help with any task. Within the day there are different "flows":
a work task, something for his kid, a personal task, a LinkedIn post in his voice. He
should not have to open separate threads.

Why: today every question starts a new thread, and the list grows into a pile he has to
manage. He thinks in days ("what did I do Tuesday?") and in errands within a day.

## Goals

- Atelier opens on **Today**, a page for the current local date.
- A day holds several **flows**. Each flow has its own conversation context, so a model,
  tool or account switch in one flow never leaks into another.
- Every model, mode, tool, account and web search stays available in every flow.
- A flow **carries over** across days (owner's choice, option A). A three-day Coen job
  is one flow. Each day's page shows the flows touched that day, and only that day's
  part of each one by default.
- Older days can be browsed (previous / next, a Days list) and searched.
- Existing threads migrate with no data loss. Sync keeps working, including with devices
  still on an older build.

## Non-goals

- No change to how a single conversation runs: routing, agent tools, history replay,
  memory, Build, Image, Video stay as they are.
- No new server storage model. Sync stays one document per thread.
- No calendar, to-do list or reminders in this project.

## Anti-goals (a failure even if it works)

- One shared context for the whole day. The agent withholds web search in a thread that has
  an earlier finished tool step or outside text (`runAgent`, app.js ~2880-2902, unless the
  owner's "Approve everything" is on). A shared day would hit that after the first tool call
  of the morning, and work-flow tool results would sit in the kid flow's context.
- Losing or duplicating any existing thread, entry or media during migration or sync.
- A Today page that hides the composer behind extra taps on the phone.

## Constraints found in the code

- A thread is one IndexedDB record `{id, title, createdAt, updatedAt, entries}`. Sync
  (`public/sync.js`, `public/sync-merge.js`, `src/sync.js`) pushes one R2 document per
  thread. The only synced thread-level fields are `title` (+ `titleRev`) and `createdAt`.
- Composer choices (mode, model per mode, think, voice, web) are global (`S.opts`, saved
  in localStorage), not per thread.
- `public/thread-spaces.js` already sorts threads with the fast helper model into the
  owner's groups (Personal, Coen, Edgeball, Other work, My apps). Kept locally, never synced.
- Boot resumes `lastThread` only when it was touched in the last 6 hours (`app.js` ~7969).
- App copy follows the humanizer rules (≤16 words a sentence, `tests/humanizer-copy.test.mjs`).
- `public/app.js` is CRLF.

## Approaches considered

1. **Flows are threads with a tag; a Day is a view.** (Chosen.) Each flow is today's thread
   record plus a `flow` field. A Day lists the flows with entries on that date. Context,
   taint rules, sync, history and trash all keep working per flow. Cost: one new synced
   field and a new home screen.
2. **One document per day, entries tagged by flow.** Context filtered per flow at send time.
   Rejected: rewrites sync and the R2 format, migrates every thread into new documents,
   and puts every flow's account data in one record where the taint rule sees it.
3. **Keep threads, just group the drawer by day.** Cheapest, but it is the thread pile with
   new headings. It doesn't give him one place to work all day.

## Design

### Data

- `thread.flow = { kind, color? }`, optional.
  - `kind`: one of the flow kinds below, or `'other'`.
  - The flow's name is the thread's existing `title`, so "Coen: Hall kitchen" and
    "Coen: Smith deck" are two flows of kind `coen`.
- Flow kinds (owner workspace): `coen`, `edgeball`, `work` (other work), `personal`,
  `kid`, `linkedin`, `apps`. Testers and guests: `work`, `personal`, `kid`, `linkedin`.
  Each kind has a label, a short label and a colour token. This extends the existing
  group sets in `thread-spaces.js` rather than adding a second list.
- `thread.opts`: the flow's own composer choices, the same shape as `S.opts` plus `mode`.
  Local to the device (not synced). When a flow is opened, `S.opts` and `S.mode` load from
  it. Changes in the composer save back to it. A new flow starts from the kind's defaults,
  then the last global choices.
- Days are derived, never stored: a flow is "on" local date D when any of its entries was
  made or last remade on D. Forks keep the original `createdAt` (sync-merge.js ~394), so a
  regenerate or edit stamps the entry with `at` (the time of the newest version) and day
  membership reads `at ?? createdAt`. (Builder's call: redoing an old turn today is work
  done today.) A flow with no entries yet lives on today.
- **Kind's source of truth is the synced `thread.flow.kind`.** The sorter's local map
  (`thread-spaces.js`) is only a fallback guess for threads without `flow`. The drawer's
  "By group" reads `flow.kind` first, then the guess. (Builder's call.)

### Sync

- Add `flow` and `flowRev` to the thread document, mirroring `title` / `titleRev`:
  the push body may carry `flow: {v, base}`, applied when `base` is the current `flowRev`
  (last writer with a matching base wins, like the title).
- Validation: `v` is `null` or `{kind: string ≤ 24, color?: string ≤ 16}`.
- Older clients never send `flow`; the server keeps the stored one (`copyDoc` spreads the
  document). Older clients pulling a document with `flow` ignore it (`checkView`,
  sync-merge.js ~365, checks only known fields). Add tests for both.
- The pull keeps local-only fields like `opts` (`applyPlan` rebuilds entries in place).
- `public/sync.js` needs work too, not only the merge core:
  - push detection (sync.js ~1768 dirty flag, ~2077 `maybeChanged`; `planPush` in
    sync-merge.js ~807) must treat a changed `flow` like a changed title;
  - the open-tab three-way merge (sync.js ~373, ~693) and `applyPlan`'s title guard
    (sync-merge.js ~969) must carry `flow`, or the open tab's next save overwrites a flow
    that arrived by sync.
- A tombstone clears `flow` as it clears the title.

### Migration

- Adding `kid` and `linkedin` changes the owner's group set, and a new set id would drop
  every stored sorter answer. Instead the new set (`owner2`) first copies the `owner1`
  answers forward, so his earlier choices survive. Hand choices (`key!`) are written to
  the thread as a synced `flow` on first load, since he already confirmed them.
- No rewrite of stored threads. A thread with no `flow` shows on the day(s) of its entries
  with kind from the existing sorter (`thread-spaces.js`) when known, else "Unsorted".
- The first time the owner opens a past day, unsorted threads on it are sorted in the
  background (the existing batch sorter). The answer is stored as `thread.flow` only when
  he confirms or edits it, or when he sends a new turn in that flow. Until then it stays
  a local guess, so a wrong guess never syncs.
- `lastThread` becomes `lastFlow`, read the same way (update `OWNER_LS_KEEP`, app.js ~6257).

### Screens

**Today (home).** Replaces the welcome screen as the place Atelier opens.

```
┌ Thu, Nov 13  ◀ ▶                          🔍 Search days ┐
│ [All] [● Coen: Hall kitchen] [● Kid] [● LinkedIn] [+ Flow] │
│  09:12 ● Coen      Estimate for the Hall kitchen…        │
│  10:40 ● Kid       Science fair ideas with magnets       │
│  13:05 ● LinkedIn  Post about the bid we won, my voice   │
│ ┌ In: [Coen ▾]  Ask ▾  Sonnet ▾  🌐 ─────────────────────┐ │
└───────────────────────────────────────────────────────────┘
```

- **Flow tabs** across the top: All, then today's flows (most recent first), then `+ Flow`.
  On the phone they scroll sideways in one row.
- **All**: a timeline of today's prompts across flows, newest at the bottom, each with its
  flow chip and time. Tapping a row opens that flow scrolled to it. All is a view only: it
  never sends a turn with mixed context.
- **A flow tab**: the normal conversation view for that thread. By default it shows today's
  entries; a "Earlier in this flow · N" bar above them expands the rest. The model still
  gets the flow's whole history, as threads do now.
- **Composer**: an "In:" flow picker sits at the front of the controls. From All, it
  defaults to the last flow used today; `+ New flow` is in the picker. When a new flow's
  first prompt is sent, the helper model suggests kind and title (as titles are made today);
  he can change either from the flow tab's menu.
- **Carry-over**: a flow from an earlier day that gets a new turn today appears in today's
  tabs. The Days list and search show flows from any day; opening one and sending brings it
  into today.
- **Day navigation**: ◀ ▶ step to the previous / next day that has entries. The date opens
  a Days list (newest first, each day with its flow chips). Past days are read-and-continue:
  sending in a past day's flow works and the turn lands on today.
- **Search**: the existing thread search, now over flows, with results grouped by day.
  It matches titles and prompts as today.

### Flow kinds with defaults

- `linkedin`: Ask mode with "As me" voice on (the existing `params.voice` path and the
  humanizer). The LinkedIn tools the agent already has stay available.
- `kid`, `personal`, `work`, `coen`, `edgeball`, `apps`: Ask mode, Auto model.
- Accounts: there is no account picker today; the agent picks a mailbox per tool call
  (`mailFrom`, app.js ~2844). That stays. The run's system prompt gains one line naming the
  flow's kind ("This flow is about Coen Construction"), so the agent leans to the right
  account and asks when unsure. No hard pin: pinning would change who mail is sent from,
  which is a safety change for its own project. (Builder's call.)
- Every flow can switch to any mode, model, tool or account; the defaults only set the start.

### What stays the same

- Per-flow context, history window, memory anchor, taint and web-search rules, agent tools,
  Build apps, Remix, Recently deleted, export/backup.
- The Threads drawer remains reachable as "All flows" for bulk actions (pin, delete,
  export), sorted by day.

## Build order (for the plan)

1. Pure module `public/days.js`: date keys, flows-on-a-day, day list, today's slice of a
   flow, kind sets. Tests first.
2. Sync: `flow` / `flowRev` in `sync-merge.js`, `src/sync.js` and `public/sync.js` (push
   detection, open-tab merge), with old-client tests in `sync-merge`, `sync-worker`,
   `sync-client` and `sync-sim`.
3. Per-flow `opts` load/save in `app.js`.
4. Today page, flow tabs, All timeline, composer flow picker (`index.html`, `app.js`,
   `studio.css`).
5. Day navigation, Days list, search by day; boot opens Today.
6. Migration of unsorted threads via the existing sorter; kind defaults.
7. Version bump, `npm run check`, `npm test`, verification on the :8791 fixture (desktop and
   phone width).

## Left to the builder

- Exact colours (from existing studio tokens), icons and copy wording within the humanizer rules.
- How the All timeline paginates on a busy day.
- Whether `thread-spaces.js` is extended in place or `days.js` imports from it.
