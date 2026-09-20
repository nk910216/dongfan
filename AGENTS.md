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

Today the web client keeps no sync cursor — only the unresolved adds under
`dongfan.pending-creates`, which are step 1. Steps 2 and 3 become real with
the offline layer in M2, and this list has to be revisited then.

## Environment and secrets

- Never read, write or commit `.dev.vars` or any secret.
- Never run a command against the production database, and never pass
  `--remote` to a `wrangler d1` command, to `scripts/backup.sh`, or to
  `scripts/users.mjs`. `npm run db:migrate:remote` is the same rule.
- Never pass `--env production` to anything.
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
