# dongfan

A baby activity log for one family: feeds, sleep, nappies, growth.
Built as a PWA on Cloudflare Workers and D1.

See [`spec.md`](spec.md) for what is being built and why, and
[`AGENTS.md`](AGENTS.md) for how to work in this repository.

## Getting started

```sh
npm install
npm run db:migrate   # create the local dongfan-dev database
npm run db:seed      # fill it with invented records, and print an account
npm run dev:all      # the worker and the web server together
```

`dev:all` prints the address to open on a phone on the same network. Sign in
with the account the seed script printed; if that has scrolled away,
`npm run users -- password dev-parent-a` issues a new one.

[`docs/running-locally.md`](docs/running-locally.md) has the rest: which
address does what, how to create an account on an empty database, and the
M1 checks that can be done without deploying.

It will refuse to start if something already holds a port. Stop the old one
rather than working around it — a dev server left running serves the code it
had when it started, and a phone pointed at it looks completely normal while
being hours behind.

## Backend

The worker and its database are local only. Nothing here reaches production.

```sh
npm run db:migrate    # apply migrations to the local dongfan-dev database
npm run db:seed       # fill it with invented records
npm run users -- list # accounts; see `users -- ` with no command for the rest
```

`dev:api` builds the web assets before starting, because the worker serves
them and refuses to start without the directory. That also makes hitting the
worker directly on port 8787 a close approximation of what gets deployed;
port 5180 is the one with hot reload.

`npm run users -- create <name>` generates a password and prints it once.
`npm run users -- assign <name> <babyId> owner` is how a second parent gets
access before the invite screen exists. Add `--remote` to work on the
deployed database instead; every run prints which one it is about to change,
and a deployed write has to be confirmed by typing that database's name.

Signing in on an account with no baby shows the form to create one, so a
freshly deployed database is not a dead end.

## Backups

```sh
npm run backup                              # the deployed database
npm run backup -- --local                   # dongfan-dev, for a drill
npm run restore:drill -- backup-2026-09-20.sql
```

The backup script always spells out `--remote` or `--local`, because the
default is undocumented and getting it wrong exports an empty database
without saying so. It rejects a file with no event rows in it, and writes a
`.counts.json` beside the dump recording what the source held. Keep the two
together: without the counts a drill can only check a backup against itself,
and one taken against an empty database passes that.

The drill restores into a scratch database of its own and checks the records
came back, including an event that crosses midnight and one carrying tags. A
file that contains `INSERT INTO events` proves there is a file; only the
drill proves anything can be recovered.

`.github/workflows/backup.yml` runs the export weekly.

## Deploying

Not yet. The plan is to build and use the app locally through M4 and decide
about deploying afterwards, so there is no deployed worker and no remote
database. [`docs/deployment.md`](docs/deployment.md) is written and ready
for when that changes; none of it has been done, and the acceptance checks
that need a real deployment are outstanding, not passed.

## Checks

```sh
npm run typecheck    # tsc across the workspace
npm run lint         # eslint
npm test             # vitest
npm run check:lang   # no Chinese outside the whitelist
```

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Types, event type config, date utilities, interface copy |
| `packages/api` | Cloudflare Worker (Hono) and the D1 schema |
| `packages/web` | React PWA |
| `scripts` | Maintenance scripts |
