# Running it, and using it from a phone

Everything in this project runs on one machine against a local database.
Nothing here deploys, and nothing reaches a remote database.

## Start it

```sh
npm run dev:all
```

One command, two servers. It builds the web assets, starts the worker and
the web server, and prints the address to type into a phone on the same
network:

```
  On this machine   http://localhost:5180
  On your phone     http://192.168.x.x:5180

  The worker alone  http://localhost:8787
```

Stop both with Ctrl-C.

### If it refuses to start

It checks the two ports first and will not start if either is taken:

```
Something is already listening:

  port 5180, where the web server goes
    pid 24103  Sun Sep 20 13:53:23 2026  node .../vite
```

**Stop the old one rather than working around it.** This is the failure
that is worth knowing about, because nothing about it looks wrong: a dev
server serves the module graph it built when it started, so one left
running since the morning goes on serving the app as it was that morning.
The phone loads it, it looks completely normal, and it is hours behind —
missing, for instance, the entire login screen. Meanwhile every later
`npm run dev` has been exiting with "Port 5180 is already in use", one line
above a stack trace, in a terminal nobody is reading.

That is not hypothetical. It is exactly what "the phone cannot log in"
turned out to be.

## Sign in

There is no sign-up page, by design (spec 9.1). Accounts come from the
command line and passwords are generated, never chosen:

```sh
npm run users -- list                    # who exists
npm run users -- password dev-parent-a   # print a new one for an account
npm run users -- create <name>           # a new account
```

`password` prints the new password once and there is no way to read it
back. Take it to the phone before closing the terminal.

Typing twenty-four generated characters into a phone, repeatedly, to check
whether a button is reachable is its own kind of bad idea. For that:

```sh
npm run users -- password dev-parent-a --weak-password
```

It then accepts anything, including `123`. The flag works on the local
database only and is **refused outright** with `--remote`: the minimum
length exists because the platform caps hashing cost far below what OWASP
asks for, which leaves length as the thing actually protecting a database
that could leak (spec 9.3) — and a scratch database of invented records on
a home network is not that one.

Logging in never checks the minimum, by design, so an account whose
password was set this way keeps working if the policy is later raised. Do
not carry one of these to a deployed database; make a fresh account there.

If the database is empty, create an account, sign in, and the app will ask
you to create the first baby — that is the only thing it can do at that
point, and it is the whole of the setup.

```sh
npm run db:migrate                       # create the tables
npm run db:seed                          # optional: invented records to look at
```

`db:seed` prints two accounts with their passwords. It refuses to run twice,
so it will never write over what is there.

## Which address does what

| | For | Notes |
|---|---|---|
| `http://<ip>:5180` | the phone, and the browser | Vite serves the app and proxies `/api` to the worker |
| `http://localhost:8787` | checks that need a deployment shape | The worker serving the **built** assets, as a deployment does |

The worker listens on this machine only. A phone cannot reach port 8787,
and does not need to: the requests it makes go to 5180 and are proxied.

Port 5180 is fixed and strict. If it is taken the server refuses to start
rather than quietly moving, because a second server on a shared port can
end up serving a different application at the same address.

## M1 checks that can be done here

These were written up as needing a deployment. They do not: `wrangler dev`
serves the built assets through the same bindings a deployment uses.

### The API is not shadowed by the static assets

Workers Assets answers before the Worker by default, so an API request can
come back as the app's HTML with the handler never running.
`run_worker_first` reverses that (spec 10.2).

```sh
curl -i http://localhost:8787/api/nope     # JSON 404, not HTML
curl -i http://localhost:8787/event/abc    # the app's HTML, not a 404
```

Against port 5180 this proves nothing: Vite has its own proxy and its own
fallback, and neither is what gets deployed.

### Adding an event from a phone over plain HTTP

`crypto.randomUUID()` needs a secure context, which a phone on a LAN
address over HTTP is not. The client falls back to `crypto.getRandomValues`,
and without it no event could be created at all (spec 10.1).

Open `http://<ip>:5180` on the phone, sign in, add one event, and confirm it
appears. Doing this over HTTPS proves nothing about the fallback, because
there the fallback never runs.

### A restore drill

```sh
npm run backup -- --local
npm run restore:drill -- backup-YYYY-MM-DD.sql --compare-local
```

A real drill on a real backup is still outstanding, but the mechanism and
the checks are exercised here against synthetic data.

## What cannot be checked here

| | Why |
|---|---|
| Login CPU under the 10 ms limit | Local runs enforce no CPU limit at all (spec 9.3) |
| Backup of the deployed database | There is no deployed database |
| The scheduled backup workflow | It runs on GitHub against a deployed database |
| Installing to the home screen | No manifest yet; this belongs to the PWA work in M2 |

These stay outstanding. [`deployment.md`](deployment.md) is what to do when
deploying becomes the plan; none of it has been done.
