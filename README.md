# dongfan

A baby activity log for one family: feeds, sleep, nappies, growth.
Built as a PWA on Cloudflare Workers and D1.

See [`spec.md`](spec.md) for what is being built and why, and
[`AGENTS.md`](AGENTS.md) for how to work in this repository.

## Getting started

The app talks to a real local API, so two processes are needed. In one
terminal:

```sh
npm install
npm run db:migrate   # create the local dongfan-dev database
npm run db:seed      # fill it with invented records, and print an account
npm run dev:api      # the worker on http://localhost:8787
```

In another:

```sh
npm run dev          # http://localhost:5180, proxying /api to the worker
```

Sign in with the account the seed script printed. If that has scrolled away,
`npm run users -- password dev-parent-a` issues a new one.

No build step is needed first: the web package resolves `@dongfan/shared`
from source, so a fresh checkout runs and edits to the shared config reach
the screen immediately.

The port is fixed and strict. If it is taken the server refuses to start
rather than quietly moving, because a second server on a shared port can
end up serving a different application at the same address.

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
access before the invite screen exists.

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
