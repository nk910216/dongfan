# Deploying, and what has to be checked by hand

Written for whoever is putting this in front of a real family for the first
time. Everything here needs a Cloudflare account and a phone, so none of it
can be settled by the test suite.

`spec.md` section 12.1 lists the acceptance criteria; this is how to work
through them.

## Two configurations, one file

`packages/api/wrangler.jsonc` describes both environments:

| | Worker | Database bound to `DB` |
|---|---|---|
| default | — | `dongfan-dev`, local, invented records |
| `--env production` | `dongfan` | `dongfan`, deployed, real records |

The local one is the default so that `wrangler dev`, the local migrations,
the seed and the tests all land there without anyone having to remember a
flag. Reaching the real one takes `--env production`, which is something you
have to have meant.

Every command below names the **binding** `DB` rather than a database. Which
database that is comes from this file and nowhere else, so a maintenance
script and the deployed worker cannot come to mean different things — they
did once, and `scripts/test/wrangler-config.test.mjs` now fails if they
drift apart again.

## One-time setup

```sh
npx wrangler login
npx wrangler d1 create dongfan
```

Put the returned `database_id` into `packages/api/wrangler.jsonc`, under
`env.production.d1_databases`, replacing
`replace-with-the-real-database-id`. Leave the default block alone: that is
the local development database and it stays a placeholder.

Then apply the migrations to the deployed database:

```sh
npm run db:migrate:remote
```

`--remote` is spelled out there and everywhere else in this file. Several
`wrangler d1` subcommands accept both `--local` and `--remote` and do not
document which they pick when neither is given. The failure is silent: the
command succeeds, against the wrong database.

## Deploying

```sh
npm run deploy
```

That builds the web assets and then runs `wrangler deploy --env production`.
Deploying without building ships whatever `packages/web/dist` happened to
contain, which is usually the previous version and occasionally nothing at
all. Deploying without `--env production` would bind the live worker to
`dongfan-dev`, which does not exist remotely.

Check the bindings before the first real deploy:

```sh
npx wrangler deploy --config packages/api/wrangler.jsonc --env production --dry-run
```

It must print `env.DB (dongfan)`. If it says `dongfan-dev`, the environment
flag is missing.

## Accounts

There is no sign-up page, by design (spec 9.1). Accounts are made from the
command line:

```sh
npm run users -- create <name> --remote
npm run users -- babies --remote
npm run users -- assign <name> <babyId> owner --remote
```

Every run prints which database it is about to change, and a write against
the deployed one asks you to type its name first. Passwords are generated
and printed once; there is no way to read one back.

Signing in on a fresh account shows the form to create the first baby;
there is nothing else it could show, and nothing else can be recorded until
one exists. `npm run users -- babies --remote` then prints its id, which is
what `assign` needs to give the second parent access before the invite
screen exists (spec 12).

## Acceptance checks

These are the ones that cannot be done locally. Each is listed in spec 12.1
as something that will otherwise be discovered at the worst possible moment.

### 1. Login CPU, on the real platform

The free plan allows 10 ms of CPU per request and login runs 50,000 rounds
of PBKDF2. Local runs enforce no CPU limit at all, so a login that is
comfortable on a laptop can fail on every attempt once deployed (spec 9.3).

```sh
curl -s -o /dev/null -w '%{time_total}\n' \
  -X POST https://<worker>.workers.dev/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<name>","password":"<password>"}'
```

Wall time is not CPU time, so the number to trust is the one Cloudflare
reports: open the Worker in the dashboard, or run `npx wrangler tail`, and
read the CPU time on a login request.

- Comfortably under 10 ms: done.
- Near or over it: lower `PBKDF2_ITERATIONS` in
  `packages/shared/src/constants.ts` and raise `MIN_PASSWORD_LENGTH` to
  compensate.

**Lowering the constant does not make an existing account any faster.** A
stored hash carries the iteration count it was made with — that is what
lets old hashes keep verifying — so an account created at 50,000 rounds
still costs 50,000 rounds to log in, whatever the constant now says. The
full sequence is:

```sh
# 1. edit PBKDF2_ITERATIONS and MIN_PASSWORD_LENGTH
npm test                                   # the constants are asserted
npm run deploy
npm run users -- password <name> --remote  # rehashes at the new cost
# 2. measure again
```

Every existing account needs that reset, not just the one being measured,
or the others keep failing exactly as before. `npm run users -- list
--remote` is the list to work through.

Record the measured figure somewhere. It is the only evidence this was
checked.

### 2. Adding an event from a phone over plain HTTP

`crypto.randomUUID()` needs a secure context, which a phone on a LAN address
over HTTP is not. The client falls back to `crypto.getRandomValues`, and
without it the id generation throws and no event can be created at all
(spec 10.1).

```sh
npm run dev:api     # one terminal
npm run dev         # another
```

On a phone on the same network, open `http://<laptop-ip>:5180`, sign in, and
add one event. The event id in the request must be a well-formed UUID and
the event must appear in the list.

This is worth doing over plain HTTP specifically. Over HTTPS the fallback
never runs, so testing there proves nothing about it.

### 3. The API is not shadowed by the static assets

Workers Assets answers before the Worker by default, so an API request can
come back as the app's HTML with the handler never running.
`run_worker_first` reverses that (spec 10.2), and it is worth confirming on
the deployed version rather than locally.

```sh
curl -i https://<worker>.workers.dev/api/nope
curl -i https://<worker>.workers.dev/event/anything
```

The first must be a JSON 404 (`{"error":{"code":"NOT_FOUND"...}}`), not
HTML. The second must be the app's HTML, so that opening a link to an event
directly does not 404.

### 4. A restore drill on a real backup

A file with `INSERT INTO events` in it proves there is a file. Only a
restore proves the records come back (spec 12.2).

```sh
npm run backup                          # writes backup-YYYY-MM-DD.sql
npm run restore:drill -- backup-YYYY-MM-DD.sql
```

The drill restores into a local scratch database, compares the row counts,
and reads back an event that crosses midnight and one carrying tags. It
fails loudly rather than printing a warning.

It makes three comparisons, and only one of them answers the question
spec 12.2 asks:

| Against | Catches |
|---|---|
| the rows in the file | a restore that stopped partway |
| the source counts in `backup-YYYY-MM-DD.counts.json` | **an export that was already short** |
| the local development database, with `--compare-local` | only useful for a drill on a local backup |

The counts file is written by `scripts/backup.sh` at export time, from the
database being exported. **Keep it with the `.sql`.** Without it, the drill
says so and cannot make the middle comparison — a backup taken against an
empty database restores completely and passes everything else.

Note what the drill does with the dump, because a restore by hand has to do
the same: `wrangler d1 execute --file` will not ingest wrangler's own export
as it stands. The tables come out in alphabetical order, so `baby_members`
and its foreign key arrive before `users` exists, and the restore stops
partway with `no such table: main.users`. The drill applies every `CREATE`
first and every `INSERT` second, with `PRAGMA defer_foreign_keys=TRUE` on
the second pass.

### 5. The scheduled backup actually runs

`.github/workflows/backup.yml` runs weekly. It needs two repository secrets:

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A token with D1 read access |
| `CLOUDFLARE_ACCOUNT_ID` | The account id in the dashboard URL |

**Check the retention limit first**, under Settings → Actions → General →
Artifact and log retention. Monthly copies ask to be kept for 400 days, and
`retention-days` is a request rather than a setting: a repository maximum
below it shortens the artifact to fit, with a warning nobody reads and a
green tick. A public repository cannot exceed 90 days at all, so keeping a
year of monthly backups means a private repository.

The workflow reads the artifact back after uploading and fails if it is not
actually being kept for as long as it asked, so a shortened copy is loud
rather than silent.

Then run it once by hand from the Actions tab, and check the artifact
contains both the `.sql` and the `.counts.json`.

**Check that failure notifications are on**, under Settings → Notifications →
Actions. A scheduled backup whose failures are silent is not a backup; it is
a belief about a backup (spec 12.2).

### 6. Signing in on a phone

Open the deployed URL on a phone, sign in, and add an event.

Adding it to the home screen is **not** a check for this milestone. There is
no web app manifest yet and no service worker, so it would be installed as a
plain bookmark: it may or may not lose the browser chrome depending on the
platform, and that says nothing about anything. Installation and the update
flow belong to the PWA work in M2 (spec 12), and the check goes there.

iOS clears storage for sites not used in seven days (spec 9.6), which means
a sign-in can vanish on its own. That is expected here; it becomes
consequential once the offline queue exists, and is handled in M2.

## After restoring a backup

Restoring moves `rev` backwards while a phone still holds the larger cursor
it had before. `rev > since` then matches nothing, for ever, and the app
looks perfectly healthy while never receiving another record (spec 12.2).

On every device:

1. Keep whatever is waiting to be sent. It is not on the server.
2. Clear the synced local cache and the sync cursor.
3. Sync again from `since=0`.
4. Send the kept items.

In this milestone the web client keeps no sync cursor yet: only the
unresolved adds under `dongfan.pending-creates` in local storage, which are
step 1. Steps 2 and 3 become real with the offline layer in M2, and this
note has to be revisited then.
