# AGENTS.md

Working agreement for anyone — human or agent — writing code in this repository.

## Read the specification first

**`spec.md` is the source of truth. This file does not replace it.**

Before implementing anything, read the sections of `spec.md` that cover the area
you are touching. This file tells you *how* to work here; `spec.md` tells you
*what* to build and, more importantly, *why* certain decisions are the way they
are. Several of its rules fail silently when ignored — the code still runs and
the tests still pass, but data is lost or corrupted weeks later.

`spec.md` is written in Traditional Chinese. That is deliberate and documented
in its section 13.1. Read it as-is; do not translate it, and do not "fix" its
language.

Section references below (`spec 3.4.1`) point into `spec.md`.

## Project layout

```
packages/
  shared/   Types, event type config, Zod schemas, date utilities, UI copy.
            Single source of truth. Imported by both api and web.
  api/      Cloudflare Worker (Hono). Also serves the built web assets.
  web/      React PWA (Vite).
scripts/    User management CLI, backup.
```

`packages/shared` must not import from `api` or `web`. The dependency arrow
points one way only.

## Language policy

Everything a developer or an agent reads is **English**: identifiers, comments,
JSDoc, README and docs, test names, test data, commit messages, PR descriptions,
review comments, error code constants.

**Interface copy** — text a developer writes for a user to read — is Traditional
Chinese and lives in exactly one file:

```
packages/shared/src/i18n/zh-TW.ts
```

No other file may contain a Chinese string literal: not the event type config,
not business logic, not API responses. The API returns error `code` values; the
web layer resolves a code to text through that file.

**This rule does not apply to data a user types.** Baby nicknames, event notes
and tag names may be in any language. They must be stored, queried and returned
by the API byte-for-byte unchanged. Stripping non-ASCII, transliterating or
escaping user content is a bug, and length limits count characters, not bytes.
There must be tests proving Chinese user content round-trips intact.

Three paths are whitelisted for CJK characters, enforced by a CI scan
(spec 13.3) — the scan exists because breaking this rule produces no symptom:

1. `spec.md`
2. `packages/shared/src/i18n/zh-TW.ts` — interface copy
3. `packages/*/test/fixtures/user-content.ts` — sample user input for the
   round-trip tests; fixtures only, never logic

When talking to the repository owner, use Traditional Chinese. When writing
anything that lands in the repository, use English.

## Where the project is

Local only. Nothing is deployed, there is no remote database, and the plan
is to reach M4 running on one machine before deciding about deploying at
all. `docs/deployment.md` is written and ready; nothing in it has happened.

The acceptance criteria in spec 12.1 that need a real deployment — the login
CPU measurement, a backup of the deployed database, the scheduled workflow
— are **outstanding**. Do not describe them as passed, and do not try to
carry them out.

`npm run dev:all` starts both halves against the local database and prints
the address for a phone. `docs/running-locally.md` covers the rest.

### Milestones

**M1 is done** apart from the acceptance above. The app records, edits and
deletes events, runs timers, and has been used from a phone over the local
network.

**M2 is in progress**, in stages, each one reviewed before the next begins.
The order follows the dependencies rather than the list in spec 12: the
queue and the drafts both need somewhere to live, so the local store comes
first.

| | | |
|---|---|---|
| 1 | IndexedDB as the persistent copy, and incremental sync into it | **done** |
| 2 | The offline queue: POST only, backoff, retry cap, `outcome_unknown`, a list of what failed, "N unsynced" | **done** |
| 3 | The offline stop-timer draft (spec 7.2) | **done** |
| 4 | PWA: manifest, service worker, update flow, the iOS add-to-home prompt | **done** |
| 5 | Members and invite codes (spec 6.5) | **done** |

**M3 is in progress**, in stages, each one reviewed before the next. The
order follows the dependencies rather than spec 12's wording, as M2's did:
the calendar and `duration_sum` both stand on the same midnight split, and
the stats endpoint cannot be shown to be correct — or cheap — before there
is a year of data to point it at.

| | | |
|---|---|---|
| 1 | The day boundary: what a day's calendar contains (spec 3.4.1, 7.5) | **done** |
| 2 | The single-day calendar screen: date picker, back to today, the FAB, writing something up afterwards | **done** |
| 3 | A year of synthetic data in its own database, the D1 query-count guardrail (spec 11.2), and `GET /stats` for `count`/`sum`/`last`/`max`/`avg` | **done** |
| 4 | `duration_sum`: the midnight split in SQL, `UNION ALL`, excluding running timers | |
| 5 | The stats screen: type, range, chart kind, axis density, the two warnings | |
| 6 | The M3 measurement (see below) | |

### A day's calendar is not a day's list

`local_date` comes from `started_at`, so a sleep from 23:00 to 07:00 is
counted on the earlier evening. A calendar for the morning that asks only
`local_date = D` loses seven hours of that morning and says nothing
(spec 3.4.1).

So there are two questions and the repository answers both, separately:

- `eventsOnDate` — what is **counted** on this day. The home screen shows
  this, because the figures printed beside it are computed the same way,
  and a list that disagreed with the numbers next to it would be worse
  than an incomplete one.
- `calendarDay` — what was **happening** on this day: the above, plus
  anything that ran into it from the day before, each entry saying whether
  it was carried over and how many of its milliseconds belong here.

They differ by exactly that one case, and `sync.test.ts` pins the
difference rather than leaving it to be discovered.

Only the previous day is read, and that is a consequence rather than an
assumption: an event lasts at most 24 hours, so it crosses midnight at
most once (spec 3.4.1 rule 1). If that limit moves, this widens with it.

An unfinished event contributes **zero** duration to every day, including
its own (spec 3.4.1 rule 3) — but zero duration is not absence. A running
timer still belongs on the day it started, and on no other, or it appears
twice for as long as it runs.

`GET /events/day/:date` was commented as serving the calendar screen. It
does not, and never did: both screens read their day out of IndexedDB
because a day has to open with no network (spec 6.2). The endpoint has no
client at all.

### Writing something up afterwards

The day an add is for travels in the query string — `/add?on=2026-09-18`,
`/add/bottle?on=2026-09-18` — and not in router state. State is gone after
a reload, and the screen would carry on looking identical while meaning
something else: a record for the 18th quietly becoming a record for now
(spec 2.1). `lib/dated-add.ts` holds the decisions so both screens make
them the same way.

**Spec 7.3 decides two of them, and an earlier version of this got both
wrong by reasoning from first principles instead of reading it:**

- **The default time is the day being looked at, at the current time of
  day.** Not midday. The argument for midday — that a time carried over
  from the clock reads as observed and gets saved unlooked at — only ever
  applied to the form. The nappy shortcut has no time field, so midday was
  written there with nothing to confirm it against: a nappy at 12:00 the
  app invented.
- **Afterwards it returns to the day the calendar was showing**, whatever
  time was finally entered, and never to today. Spec 7.3 spells out the
  sequence it exists to prevent: pick yesterday, press add, be handed a
  form defaulting to today, and be dropped back on today after saving.
  That is the one place in the whole flow where people misremember which
  day they filed something under.

Today returns to `/day`, not to today's date, so it keeps meaning today
after midnight.

**A dated add defaults to `record`, never `start_timer`.** Saved as a timer
it stores a sleep that began four days ago and is still running: instantly
past the 24-hour limit, so the stop button turns into the correction form
(spec 7.2), while holding the only `active = 1` slot its type has — so
tonight's sleep cannot be started either (spec 3.5). A resumed draft or a
queued entry keeps the intent it was written with; only the default moves.

**The form draft is named with the day.** Without that, a half-typed feed
for the 18th is offered back on the 19th's form, holding the 18th's instant
while the heading says the 19th — and the wrong one of those two is what
gets saved.

**Both screens say which day they are filing under.** A form for the 18th
looks exactly like a form for now.

### One sync control, on both screens

Spec 6.1 asks for a manual sync on the home screen **and** the calendar.
The calendar shipped without one: it read IndexedDB and had no way to ask
for anything, so somebody sitting on last Tuesday while the other parent
added to it had to leave the screen to find out.

`components/SyncState.tsx` is that control, shared, so the two cannot end
up disagreeing about what "synced" looks like. It drives the store's
`refresh` rather than fetching anything itself: the calendar is a reader,
and a second way of pulling would be a second cursor to get wrong
(spec 5.4).

### Rows are shared, not copied

`components/EventRow.tsx` holds `EventRow`, `WaitingRow` and
`describeQueued`, because spec 7.5 asks for the calendar's events to look
like the home screen's, and two copies would answer that on the day they
were written and then drift apart a badge at a time.

An all-day event sorts **above** everything, in `calendarDay` rather than
in a screen. It is stored at local midnight (spec 3.9), so by the clock it
would sink under every feed of the day instead of heading it.

The menu button at the top left had no handler at all until the calendar
existed — there was no way in. `PageMenu` is the page list spec 7.10 asks
for.

### The statistics endpoint

`GET /babies/:id/stats?types=a,b&from=&to=` aggregates **in SQL**, and
spec 5.6 is explicit that this is architecture and not optimisation: a year
is around 7,300 events, and reading those into the Worker to add up in
JavaScript would very likely exceed the 10 ms budget — a failure that only
appears once a year of data exists, long after the code was reviewed.

Two statements at most, whatever is asked for. One `GROUP BY type_id,
local_date` serves `count`, `sum`, `max` and `avg` together, because the row
set is identical and the query budget is per request rather than per type. A
second, using `ROW_NUMBER()`, serves `last`. Neither grows with the number
of days or the number of types, and `stats.test.ts` asserts that a one-day
request and a one-year request cost the same.

**Zero-filling is a rule about meaning and it is easy to get backwards**
(spec 7.7). A day with no feeds really had no feeds, so `count` and `sum`
carry a zero. A day nobody weighed the baby is not a day the baby weighed
nothing, so `last`, `avg` and `max` leave it out and let the chart join the
points either side — filling those with zero drops a growth curve to the
floor. Done on the server so there is one implementation of it, testable
against a real database.

The range is capped at `MAX_STATS_DAYS`, which is what makes spec 5.6's "at
most 366 points" a fact: the response has one point per local date, so the
only way to bound it is to bound the range.

**`avg` has no configured type.** Every aggregation in the event type config
is `count`, `sum`, `last`, `duration_sum` or `max`. `avg` is implemented
because spec 5.6 names it, and its SQL runs on every request alongside the
others, but the branch that *selects* the mean cannot be reached through the
endpoint and therefore has no end-to-end test. Said here rather than left
looking covered.

`duration_sum` is refused with `NOT_SUPPORTED_YET` until stage 4 rather than
answered with a series computed without the midnight split. A chart quietly
missing every hour of sleep before midnight looks exactly like a chart.
Delete that code and that error together.

### The D1 query-count guardrail

`test/query-count.ts` wraps the binding and counts every statement a request
executes, failing past 30 (spec 11.2). The free plan allows 50 per
invocation and **the local runtime enforces none of them**, so a handler that
had quietly become N+1 would pass every other test and fail in production
against a baby with a year of records.

Wrapped at the binding rather than inside Drizzle, because handlers reach the
database both ways — reads through the query builder, writes as raw
statements through `batch()` (spec 4.3) — and a counter blind to one of those
reports half the work. `batch()` counts once per statement, which is what D1
charges for it.

It has been shown to bite: a deliberate query-per-day in the stats handler
takes the count from 5 to 369 and fails.

**The 10 ms CPU limit is not this.** Miniflare does not enforce it, so no
local number says anything about it. That measurement needs a deployed
Worker and remains outstanding, as spec 12.1 lists it for M3.

### A year of data, in a database of its own

`npm run db:stats-fixture` writes about 4,500 invented events across 365
days into `dongfan-stats`, which has its own configuration file
(`scripts/wrangler.stats.jsonc`) for the same reason the restore drill does:
a binding in `packages/api/wrangler.jsonc` would make `wrangler deploy` look
for a deployed database of that name.

It is deliberately **not** `dongfan-dev`. Burying the handful of records the
owner develops against under 4,500 invented ones would make the app useless
to look at, and this database exists to be filled and emptied freely. The
script looks its own account and baby up rather than assuming they are
absent, so a run that failed partway through does not make the next one
impossible — which is exactly what the first version did.

The integration tests do not use it. Their D1 is created for the run and
thrown away, so the year-scale test seeds its own rows directly into the
table; going through the API would mean thousands of POSTs and would hit the
500-a-day circuit breaker (spec 5.7), which is about runaway loops and not
about a year of history.

### Two things spec.md is not consistent about

- **Which milestone owns the `/stats` CPU measurement.** 5.6 says M4,
  12.1's acceptance table says M3. The table wins here; the prose is
  probably older.
- **The D1 query-count guardrail 11.2 asks for does not exist.** There is
  no helper counting calls per request and failing past 30. Locally that
  is the *only* half of "performance" that can be measured at all — the
  10 ms CPU limit is not enforced by Miniflare — so it belongs with the
  stats endpoint rather than with a later tidy-up.

The queue lives in `packages/web/src/lib/outbox.ts`, with its storage in
`db.ts` under `outbox`. An entry is put in doubt by `beginSend` *before*
its request leaves, not after one comes back badly: the window between the
server storing an event and the device hearing so is the window in which a
correction is lost, and a browser closed inside it has to reopen knowing
that (spec 6.1). `dongfan.pending-creates` is gone: whatever it was
holding is migrated into the queue on the first load after the upgrade,
under the account that wrote it, and marked as being in doubt — which is
the state it was always in.

Stopping a timer is the one edit that is not simply refused. The instant
the button was pressed is written to the `drafts` store **before any
attempt is made to send it**, and offered back for confirmation once the
server can be reached — never sent automatically, because the other parent
may have stopped or edited the same timer meanwhile (spec 7.2, 6.3). Every
other edit and deletion is still refused outright.

`navigator.onLine` is not the condition. It says an interface is up, not
that the server answers: a stopped worker, a captive portal and a lost
response all look like a healthy phone, and they are the same situation
for the parent. The draft is kept on every failure and removed only by a
definite success, by the confirmation, or by the event coming back already
ending at exactly the instant held here, which means the server's state is
already what the draft was asking for. That is how a stop whose answer was
lost stops asking to be confirmed, and it is a test on the state rather
than a guess about who made it.

Clearing it on *any* successful update is wrong and was a bug: correcting
a note on an event whose timer is still running would throw the moment
away and leave the timer with nothing to end it by.

The service worker never takes over by itself. A new build waits, a strip
offers it, and the page reloads only when somebody presses it — because
taking an update reloads the page and they may be part way through a feed
(spec 2.1). Two things can raise that strip: the worker finding new
assets, and `GET /api/version` differing from `APP_VERSION`, which is the
one that catches an app left open for days.

**A reload must not lose what is being typed.** `form-draft.ts` writes the
add and edit forms to `localStorage` as they are typed, not on the way
out: the browser reclaiming a background tab does not ask first. The queue
and the stop drafts are already in IndexedDB and survive on their own.

Two things about those drafts fail silently and both have already been
got wrong:

- A draft marked with the id it is being sent under says *handing over*,
  not *handed over*. The write that puts it in the queue can still fail,
  and the page can still go before it commits. `reconcileForms` settles
  it at startup against the only two places the content could have
  reached — the queue and the local events — and a draft that reached
  neither is still a draft, kept with its id so resending it cannot
  become a second record.
- An edit draft carries the version it was written against, and is sent
  with it. Pairing old fields with a freshly fetched version puts this
  device's idea of every field over whatever happened in between, and the
  server accepts it because the number it was handed is current — the
  conflict that exists to stop that is never reported. A draft that
  cannot say what it was written on is shown unapplied rather than
  guessed at, and rather than deleted: refusing to apply it and throwing
  it away are two different halves of spec 2.1, and fixing one by
  breaking the other is not fixing it.

Both of those turn on the same distinction, and it has now been got wrong
three times in three places: **having tried is not having landed.** A
mark written before a write says what was attempted. Only the store can
say what happened, so ask it — the queue for an entry, the local events
for a record, the draft itself for the version it was written on.

### State read inside the call that changed it is the value from before

`const [x, setX] = useState()`, then `setX(...)`, then a branch on `x` a
few lines later: that branch sees the old value. It has bitten three
times, twice in `JoinBaby.tsx` alone, and each time the symptom was a
screen reporting the wrong one of two outcomes — not a crash, not a
failed test, just the wrong sentence at the worst moment.

An async handler that has to act on what happened *during* this press
keeps its own local variable and sets the state alongside it. The state
is for rendering; the variable is for deciding.

The worker is off in `vite dev` and only exists in a real build, so it is
tested through `cloudflared` against the Worker on 8787, never by
deploying. `docs/running-locally.md` has the steps.

An invitation is 150 bits, works once, and stops working an hour later.
Spec 4.3 names three ways of writing that which look right: consuming the
code before writing the member (nobody is added), guarding the insert on
`used_by` (somebody removed can rejoin with the same code, expired or
not), and taking the baby from the request rather than from the code (a
valid code for one child lets you into another). All three have tests that
fail when the guard is removed.

The rate limit on joining counts in the isolate and writes nothing, as
spec 9.4 settled for the whole project: a brake that spends the day's
database allowance can be used to stop a parent recording a feed. It is
not the defence — the 150 bits are.

The second parent's first moment is the create-a-baby screen, holding a
code, with no baby and therefore no settings page to reach. The join form
is on both screens for that reason; offering only the one spec 7.1 names
would make the feature unusable for what it exists for.

Spending the code and reading the account back are two requests and fail
separately. Joined together, a failed refresh looked exactly like a failed
join — with the code already spent, so the button could only ever collect
a 404 afterwards. And a join whose answer was lost asks the account
whether it got in rather than reporting a failure, because it may well
have (spec 6.1).

Which baby the app is about is a choice, kept per account, not
`babies[0]`. Joining a second one and then not being able to reach it is a
dead end, and spec 7.10 asks for the name at the top to switch.

### The one control that must never be unreachable

`viewport-fit=cover` and a translucent status bar are what make a home
screen app fill the screen instead of sitting in a framed box, and they
do it by drawing the page *under* the notch, the Dynamic Island and the
home indicator. Nothing put it back, so on a real iPhone the top row —
menu, sync state, settings — could not be pressed at all.

The strip offering a new build is in that row. So the app could not be
updated from the phone: the fix for the notch was behind the button the
notch was covering. Taking it needed the app closed entirely, which is
what lets a waiting worker activate — no clients left to reload under.

`.safe-area` in `index.css` is applied once, to the shell in `App.tsx`,
because nothing below positions itself against the viewport: every screen
is a column of `shrink-0` chrome around one `min-h-0 flex-1
overflow-y-auto` list. Padding there comes out of that list's height, so
it scrolls rather than losing its last row.

No test can say whether the padding is the right size — jsdom has no
insets and `env()` resolves to nothing. The one in `flow.test.tsx`
asserts only that the shell still carries the treatment, and says so,
because that is how this would come back: silently, on the one device
nobody develops on.

### The phone acceptance, and what it actually proved

Carried out on a real iPhone on 2026-09-24, over `cloudflared` against
the local Worker on 8787, and **signed off by the owner**. The tunnel is
closed; it was a throwaway address and nothing was deployed.

Confirmed against the server rather than against the screen, because the
screen was the thing under test:

- **An add made with no signal reaches the server exactly once.** Three
  offline records, three `201`s, three distinct ids, no duplicates
  (spec 12.1's M2 condition).
- **A stop pressed offline keeps the moment it was pressed.** The
  confirmed event ended at 22:58:14 and was written at 23:00:32 — 137
  seconds apart (spec 7.2). A timer stopped online has the two equal,
  which is the control.
- **A record the server refused can be retried by hand.** A second timer
  of the same type came back `409 ACTIVE_TIMER_EXISTS`, the queue gave up
  and kept the content, and retrying once the first timer was stopped
  landed it exactly once (spec 11.2).
- **Installing to the home screen**, and the safe area after the fix
  above.

Accepted without being exercised one by one, so do not cite them as
evidence: the per-screen safe-area list, taking an update by pressing the
strip (it was unreachable at the time, so that round changed build by
closing the app), a half-typed form and a queued add surviving that
update, and a cold start with no network.

Everything in spec 12.1 that needs a deployment is outstanding as well.

What comes after M2:

- The summary is the server's, so a feed recorded offline does not move
  "last feed" until it is sent. That is deliberate (spec 6.2); the waiting
  row in today's list is the mitigation.
- `APP_VERSION` in `packages/shared/src/version.ts` is bumped by hand.
  Both halves read it from there, so they cannot disagree about what they
  are, but a release without a bump leaves only the service worker to
  notice.

Stage 4 needs HTTPS, which a local network address is not. Use
`cloudflared tunnel --url http://localhost:8787` (spec 10.1, option two),
against `npm run dev:api` — the Worker serving the built assets, not the
dev server, where the service worker is switched off. Deploying to get
HTTPS is not on the table.

## Before you call something done

```sh
npm run typecheck     # tsc --noEmit, zero errors
npm run lint          # eslint, zero warnings
npm test              # vitest
```

This repository uses **npm workspaces**. Run a script in one package with
`npm run <script> -w packages/<name>`.

Zero warnings is the bar, not "no errors". `any` is banned; if you reach for it,
the types are telling you something.

## Date and time: the rules that bite

These are the most common source of silently wrong data in this project. Full
reasoning in spec 3.4 and 3.4.1.

- Timestamps are stored as **UTC epoch milliseconds**. Always.
- The timezone belongs to the **baby record**, never to the device. Never call
  `getTimezoneOffset()`, never derive a date from the browser's locale.
- `local_date` (`YYYY-MM-DD`) is computed **on the server** from `started_at`
  plus the baby's timezone, and stored. A `local_date` sent by a client is
  ignored.
- All timezone conversion goes through `packages/shared` date utilities, which
  use `Intl.DateTimeFormat('en-CA', { timeZone })`. No hand-rolled offset math,
  no `moment`/`moment-timezone`.
- An event lasts at most 24 hours. That single rule is what guarantees it
  crosses midnight at most once, which is what makes the split logic simple.
- Any query that involves duration must widen its lower bound by one day before
  splitting, or it will silently miss sleep that began the previous evening.

## Cloudflare free plan limits that constrain how you write code

Not quotas to watch — hard limits that fail requests (spec 2.5).

| Limit | Consequence for your code |
|---|---|
| 10 ms CPU per request | No heavy loops. Aggregate in SQL, not in JS. |
| 50 D1 queries per invocation | No N+1. Join or batch; never one query per row. |
| 100 bound parameters per query | Never bind a list of ids. Join instead. |
| 100,000 D1 rows written per day | Never turn external traffic into DB writes. |

The local dev environment enforces **none** of these. Tests passing locally
says nothing about whether a request survives in production.

## Adding an event type

1. Add the entry to the event type config in `packages/shared`. Structure only —
   no display text.
2. Add its display name to `i18n/zh-TW.ts` under `eventType.<id>`.
3. If it needs metadata fields, define them in the config (ids and constraints)
   and add their labels and enum option labels to `i18n/zh-TW.ts`.
4. Check it against the config invariants in spec 3.1 (`timerEnabled` implies
   `hasRange`, `allDay` excludes both, aggregation implies a value spec, and so
   on). These are asserted at load time, so a bad entry throws at startup.
5. Add a test covering its aggregation behaviour.

Never reuse or rename an existing `id`. Ids are stored in the database.

## Errors

The API never returns text for a user to read. It returns a `code`, plus
machine-readable `details` where relevant, and the web layer resolves both
through `zh-TW.ts`.

`VALIDATION_FAILED` carries structured field errors (spec 5.2.1):

```json
{ "error": { "code": "VALIDATION_FAILED", "details": { "fields": [
    { "field": "value", "code": "OUT_OF_RANGE", "params": { "min": 0, "max": 500 } }
] } } }
```

`field` is the request body path, `code` is an uppercase constant, and `params`
holds the values the copy interpolates. `params` is always an object, `{}` when
empty.

The web layer **must** fall back to a generic message when it meets a code it
does not know — `error.UNKNOWN` for a top-level code, `fieldError.UNKNOWN` for a
field code — and log the raw code to the console. A published PWA updates later
than its backend, so an unknown code is a matter of when, not if. Never render a
raw code to the user.

## Adding an API endpoint

1. Define the request and response Zod schemas in `packages/shared`.
2. Register the route in the Hono app.
3. Attach the correct permission middleware — `requireBabyAccess`,
   `requireEventAccess`, `requireTagAccess` or `requireOwner` (spec 6.4).
   **Never write a permission check inside a handler.**
4. Write the handler. Reads use Drizzle. **Writes do not**: they are raw
   statements sent through `c.env.DB.batch()`, because the version guard has
   to be a predicate on every statement in the transaction (spec 4.3) and the
   query builder cannot express that. Checking `meta.changes` after the batch
   returns is too late to roll anything back. `meta.changes` on the last
   statement decides the *response* and nothing else.
   Every write that touches `events` takes its new `rev` from the `NEXT_REV`
   constant in `src/lib/events.ts`. Never write that subquery out by hand.
5. Add an integration test against a real local D1 covering: success,
   unauthenticated, cross-baby access denied, validation failure, and version
   conflict.

## Testing

Priority order, highest value first (spec 11):

1. **Pure functions** in `shared` — date bucketing, midnight splitting, unit
   scaling, aggregation, age calculation. Chase coverage here.
2. **API integration tests** on a real local D1, not a mocked SQL layer.
3. **Component tests** with MSW intercepting at the network boundary
   (`packages/web/test/server.ts`). Do not mock your own functions; that
   removes the thing under test. These cover the wiring — whether a tap
   sends the body the contract describes — not the rules, which are tested
   where they live.
4. **A few end-to-end paths**, not a suite.

Do not chase a global coverage number. Layer 1 is where the bugs are.

### A test that has never failed has not been tested

After writing a test for something that matters, **break the thing it
covers and watch it fail.** This has caught a run of tests in this
repository that passed for the wrong reason: an assertion written the wrong
way round, an event fired before the listener existed, a "did not happen"
assertion that released its gate before the thing had a chance to happen.
All three looked fine and all three were worthless.

When a guard turns out to be unreachable — a second check behind a first
that already makes it impossible — say so rather than implying coverage.
Structure it as the correct thing to do ("check what you are sending")
rather than as a conditional that pretends to be covered ("skip the check
when resending").

### Collapsing requests is right for a sync and wrong for a send

`lane.ts` has two primitives and they are not interchangeable.
`runExclusive` folds requests that arrive during a run into one, because
four requests to catch up are one catching up. `runSerial` runs every task
in turn, because each of its tasks is a particular record leaving the
device.

Sending was written on the collapsing one first. A save made while the
queue happened to be running was folded into the queue's task, never ran,
and handed its caller a resolved promise — so the screen reported that the
record had been dealt with. Nothing logged, nothing failed.

Ask which kind of work it is: "bring me up to date" collapses, "do this
specific thing" does not.

### Never build "today" out of a relative offset

`Date.now() - 2 * HOUR` is a different local day for a few minutes every
night, and it is 2am feeds this app exists for. A fixture that has to land
on today's date is anchored to the start of the local day, not to an offset
from now. Tests that pass all day and fail just after midnight are worse
than no tests.

Clamp both ends. Anchoring to the start of the day alone leaves the
opposite mistake: in the first minutes of a local day there is no "two
hours ago" that is still today, and a fixture that answers with a *future*
instant makes every end time invalid. `test/fixtures/clock.ts` does both,
and `test/clock.test.ts` pins the boundary at fixed times so that the rest
of the suite does not have to wait for the clock to come round to find out.

It applies to the API tests too, and it caught one there at one in the
morning: two events an hour apart landed on different local dates, so the
one the assertion expected first was not in the day's page at all. A test
about a calendar day names its day rather than counting backwards from
now. The rule is for anything the server buckets by `local_date` — the
day endpoint and the `today` figures in the summary — not for durations,
which do not care what day it is.

Freezing the clock for the whole suite is not the answer. At least one test
depends on time passing between a page opening and a button being tapped,
and a frozen clock makes it pass without testing anything.

Cross-cutting scenarios that must have tests (spec 11.2) — these are the ones
that are invisible to the eye:

- Two devices starting the same timer: exactly one succeeds.
- Version conflict: the event **and** its tags are both completely unchanged.
- A tag update spanning more than one page still syncs every affected event.
- A POST that succeeded but lost its response: resending neither duplicates nor
  overwrites.

## Never do these

- Edit a deployed schema by hand. Migrations are generated files, in version
  control.
- Repeat a permission check inside a handler instead of using the middleware.
- Derive a date from the device timezone.
- Soft-delete a row without also bumping `rev`, `version` and `updated_at`.
  Forgetting `rev` means other devices never learn about the deletion.
- Assign the same `rev` to several rows in a batch update. Allocate one per row,
  or pagination silently drops data (spec 5.4).
- Regenerate an event `id` when retrying. The id is the idempotency key.
- Move password hashing to the client. The hash then *is* the password.
- Store a float where the spec says integer.

## Backup and restore

`scripts/backup.sh` exports the deployed database and refuses to hand over a
file with no event rows in it. `--local` points it at `dongfan-dev`, which is
what a drill uses.

`npm run restore:drill -- <file>` restores a backup into its own local
scratch database and checks it came back whole: row counts against the file,
an event that crosses midnight, an event carrying tags, the unique index on
`(baby_id, rev)`, and every stored `local_date` still agreeing with its
timestamp. It never touches anything deployed.

**`wrangler d1 execute --file` will not ingest wrangler's own export as it
stands.** The dump is ordered alphabetically, so `baby_members` and its
foreign key arrive before `users` exists, and the restore stops partway with
`no such table: main.users` — leaving some tables filled and some empty. Apply
every `CREATE` first and every `INSERT` second, with
`PRAGMA defer_foreign_keys=TRUE` on the second pass. That is what the drill
does, and a restore by hand has to do the same.

### After a restore, every client cursor must be reset

Restoring moves `rev` backwards while a phone still holds the larger cursor
it had before. `rev > since` then matches nothing, for ever: the app looks
perfectly healthy and silently never syncs again (spec 12.2).

1. Keep whatever is waiting to be sent. It is not on the server.
2. Clear the synced local cache and the sync cursor.
3. Sync again from `since=0`.
4. Send the kept items.

All four are now concrete, and all four are in IndexedDB under the database
`dongfan`:

1. The `outbox` and `drafts` stores hold what has not reached the server:
   adds waiting to be sent, and the moment a timer was stopped. **Keep
   both.**
2. Empty the `events` and `meta` stores. `meta.cursor` is the one that
   matters; `events` goes with it because the rows it holds are ahead of
   the restored server.
3. Opening the app then syncs from `since=0`, because an absent `meta` row
   reads as a cursor of zero.
4. The queue sends what was kept, under the ids it already had, and the
   drafts are offered for confirmation as usual.

**There is no button for this.** Clearing site data from the browser would
do steps 2 and 3 and destroy step 1 with them, so it is the wrong tool. A
restore has not happened yet; if one ever does, this needs a screen or a
console snippet that empties those two stores and leaves `outbox` alone.

## Environment and secrets

- Never read, write or commit `.dev.vars` or any secret.
- Never run a command against the production database, and never pass
  `--remote` to a `wrangler d1` command, to `scripts/backup.sh`, or to
  `scripts/users.mjs`. `npm run db:migrate:remote` is the same rule.
- Never pass `--env production` to anything.
- `--weak-password` is the owner's, for the local database, and is refused
  with `--remote`. Never weaken the length policy itself to work around it.
- Never open a database that holds the owner's real records.
- Never run `wrangler deploy`.

`packages/api/wrangler.jsonc` holds both environments. The default is the
local `dongfan-dev`, so `wrangler dev`, `npm run db:migrate`, the seed and
the tests all reach it without a flag; `--env production` is what reaches
the real one. Commands name the binding `DB` rather than a database, so the
config decides what that means and a script cannot drift away from what gets
deployed — `scripts/test/wrangler-config.test.mjs` fails if it does.

`scripts/users.mjs --remote` and `scripts/backup.sh` (which defaults to
remote) exist for the repository owner, not for an agent. They print which
database they are about to change and make a deployed write be confirmed by
typing its name; neither of those is an invitation. The restore drill is
different: it is local-only by construction and safe to run.

You **may** create and use a local development database, provided it is:

1. **separately named** (`dongfan-dev`), distinct from the one the owner uses;
2. **seeded with synthetic data only**, via `scripts/seed.ts` — invented
   nicknames, notes and tags, never real family data;
3. **never committed** — `.wrangler/` and `*.sqlite*` are already ignored.

This is what makes the integration tests real: they run against actual D1
rather than a mocked SQL layer, while the owner's records stay out of reach.

Some environments run without network access. In those, `wrangler deploy`,
`wrangler d1 --remote` and anything touching remote infrastructure will not
work and must not be attempted. Install dependencies up front, run tests
locally, and report anything that genuinely requires deployment as pending
verification rather than claiming it passed.

## Commits

Small, focused, English, imperative subject. Explain *why* in the body when the
reason is not obvious from the diff — especially when the code guards against
something that fails silently.

Do not push unless asked.
