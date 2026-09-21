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

### Reading without the API

The app holds events on the device and reads them from there, so it keeps
working when the server does not answer (spec 6.2).

**Turning off Wi-Fi on the phone is not the way to check this yet.** There
is no service worker, so with no network the browser cannot fetch the page
or its scripts at all — it fails before any of this code runs, and what you
would be looking at is a browser error, not the app. Testing a cold start
with no network becomes possible in the PWA stage, and belongs there.

What can be checked now is the app running with the API unreachable. Run
the two halves in separate terminals rather than together:

```sh
npm run dev:api     # terminal one
npm run dev         # terminal two
```

Load the app on the phone, then stop the worker with Ctrl-C in terminal
one. The web server keeps serving the page; every `/api` request now fails.

- Today's events and the summary are still on screen.
- The indicator at the top says the sync failed rather than claiming it
  just succeeded.
- Reloading the page still works, and still shows the records.
- Adding an event still works. It goes into the queue, appears in today's
  list marked as unsynced, and is sent when the worker comes back.

Start the worker again and the indicator goes back to saying when it last
succeeded.

### Recording with the phone in flight mode

This is the M2 criterion from spec 12.1: record with no signal, reconnect,
and confirm it synced exactly once.

**Load the app first, then turn the network off.** There is still no
service worker, so a phone with no connection cannot fetch the page at all
and you would be looking at a browser error rather than at this code. Once
the page is open it stays open, which is the situation the queue is for.

1. Open the app on the phone over the LAN address and sign in.
2. Turn off Wi-Fi and mobile data. **Do not reload.**
3. Record a nappy from the shortcut.
   - It appears in today's list, dimmed, with an unsynced badge.
   - The strip above says how many records are waiting.
   - Tapping that strip lists them, with what each one contains.
4. Open an existing event and try to save a change.
   - It is refused, and says a connection is needed (spec 6.1). Stopping a
     timer is the one exception; see below.
5. Turn Wi-Fi back on.
   - Within a few seconds the strip disappears, the dimmed row becomes a
     normal one, and the count of today's events does not change.

Then check it landed once rather than twice:

```sh
npx wrangler d1 execute DB --config packages/api/wrangler.jsonc --local \
  --command "SELECT id, type_id, started_at FROM events WHERE deleted_at IS NULL ORDER BY rev DESC LIMIT 5"
```

One row for the nappy, with the same id the phone generated. Two rows with
different ids would mean the id was regenerated on the retry, which is the
one mistake the whole mechanism exists to prevent (spec 3.8, 5.8).

### Stopping a timer with no signal

The queue takes creations only, so stopping a timer has nowhere to go. But
refusing outright is what ruins the data: press stop at 03:10, get a signal
back at 03:40, and the sleep is recorded half an hour too long. Sleep
length is what this app is for, so the moment is written down instead
(spec 7.2).

1. Start a sleep timer from the home screen, with the network on.
2. Turn off Wi-Fi and mobile data. **Do not reload.**
3. Press the stop button on the sleep card, and note the time.
   - The card changes: no stop button, a dashed border, a badge reading
     "ended, waiting to be confirmed", and the elapsed figure frozen at
     the moment you pressed.
   - The row in today's list carries that badge instead of "in progress".
   - A strip above the shortcuts says how many are waiting to be confirmed.
4. Tap the card.
   - It says a connection is needed, and says the moment you pressed is
     still held. Nothing has been sent.
5. Turn Wi-Fi back on.
   - The screen reloads the event by itself and offers the time you
     pressed, with the duration that follows from it.
6. Press the confirm button at the bottom.
   - The sleep now ends at the time you pressed, **not** the time you
     confirmed. That is the whole point; check the two are different by
     waiting a minute before confirming.

It is never sent automatically. The other parent may have stopped or
edited the same timer while you had no signal, and the screen says so —
try it by stopping the same sleep from a second browser before confirming,
and the screen offers to keep theirs instead.

### What the queue will not do

- It takes creations only. Edits and deletions are refused while offline
  rather than queued (spec 6.1); stopping a timer is handled by the draft
  above, not by the queue.
- It stops after ten counted attempts and waits for a person. A record that
  has stopped is still in the list, with its content intact.
- "Give up" stops this phone trying. It does not mean the server does not
  have the record, and the wording on screen says so.
- The figures in the summary strip stay the server's. A feed recorded
  offline shows in the list but does not move "last feed" until it has
  been sent, because what changes when an event moves is not something a
  phone can work out (spec 6.2).

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
| Installing to the home screen | No manifest yet; this belongs to stage 4 of M2 |
| A cold start with no network | Needs a service worker, which needs HTTPS; stage 4 |

These stay outstanding. [`deployment.md`](deployment.md) is what to do when
deploying becomes the plan; none of it has been done.
