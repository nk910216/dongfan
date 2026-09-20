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

Everything a user reads is **Traditional Chinese**, and it all lives in exactly
one file:

```
packages/shared/src/i18n/zh-TW.ts
```

No other file may contain a Chinese string literal. Not the event type config,
not business logic, not API responses, not tests. The API returns error `code`
values; the web layer maps a code to its message through that file.

Two files are whitelisted for Chinese: `spec.md` and `zh-TW.ts`. A CI check
enforces this (spec 13.3) — it exists because breaking this rule produces no
symptom at all.

When talking to the repository owner, use Traditional Chinese. When writing
anything that lands in the repository, use English.

## Before you call something done

```sh
pnpm typecheck     # tsc --noEmit, zero errors
pnpm lint          # eslint, zero warnings
pnpm test          # vitest
```

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

## Adding an API endpoint

1. Define the request and response Zod schemas in `packages/shared`.
2. Register the route in the Hono app.
3. Attach the correct permission middleware — `requireBabyAccess`,
   `requireEventAccess`, `requireTagAccess` or `requireOwner` (spec 6.4).
   **Never write a permission check inside a handler.**
4. Write the handler. Multi-step writes go in a single `batch()` with the
   version guard as a predicate on every statement (spec 4.3) — checking
   `meta.changes` after the batch returns is too late to roll anything back.
5. Add an integration test against a real local D1 covering: success,
   unauthenticated, cross-baby access denied, validation failure, and version
   conflict.

## Testing

Priority order, highest value first (spec 11):

1. **Pure functions** in `shared` — date bucketing, midnight splitting, unit
   scaling, aggregation, age calculation. Chase coverage here.
2. **API integration tests** on a real local D1, not a mocked SQL layer.
3. **Component tests** with MSW intercepting at the network boundary. Do not
   mock your own functions; that removes the thing under test.
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

## Environment and secrets

- Never read, write or commit `.dev.vars`, secrets, or anything under
  `.wrangler/`. The local database contains real child records.
- Never run commands against the production database.
- Local development uses local D1 only (`wrangler dev`, vitest-pool-workers).

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
