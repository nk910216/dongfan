# dongfan

A baby activity log for one family: feeds, sleep, nappies, growth.
Built as a PWA on Cloudflare Workers and D1.

See [`spec.md`](spec.md) for what is being built and why, and
[`AGENTS.md`](AGENTS.md) for how to work in this repository.

## Getting started

```sh
npm install
npm run dev          # http://localhost:5180
```

No build step is needed first: the web package resolves `@dongfan/shared`
from source, so a fresh checkout runs and edits to the shared config reach
the screen immediately.

The port is fixed and strict. If it is taken the server refuses to start
rather than quietly moving, because a second server on a shared port can
end up serving a different application at the same address.

`npm run dev` currently serves the **UI prototype**: the screens are wired to
mock data, not to an API. A banner at the top of the app says so. Replacing it
with a real local D1 is part of finishing M1.

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
| `packages/web` | React PWA |
| `scripts` | Maintenance scripts |
