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

## The PWA: installing, offline cold start, and updates

None of this works over the LAN address. A service worker needs a secure
context, which the specification defines as HTTPS **or localhost** — and
that is decided by the URL, not by the device, so `http://192.168.x.x` is
not one (spec 10.1). The worker is also switched off in `vite dev`, where
a cached bundle would turn every edit into a puzzle.

So this is tested against a real build, served by the Worker, through a
temporary HTTPS address:

```sh
npm run dev:api                              # terminal one: builds web, serves it on 8787
npx cloudflared tunnel --url http://localhost:8787   # terminal two
```

The tunnel prints a `https://<something>.trycloudflare.com` address. Open
**that** on the phone. It is a throwaway address that disappears when you
press Ctrl-C; nothing is deployed and the database is still the local one.

### Installing it

1. Open the tunnel address on the phone and sign in.
2. On iOS, the home screen shows a strip asking you to add the app. Do what
   it says: share icon → Add to Home Screen.
3. Open it from the home screen. There is no Safari chrome, and the icon is
   the sprout rather than a screenshot.

This is not decoration. iOS clears storage for a site that has not been
opened in seven days, taking the session, the local records, the queue of
unsent adds and any unconfirmed stop with it. A PWA on the home screen is
exempt (spec 9.6).

### A cold start with no network

Only possible now that there is a service worker, and it is the thing the
earlier offline checks could not cover.

1. Open the app from the home screen at least once, with the network on.
2. Turn off Wi-Fi and mobile data.
3. **Close the app entirely** — swipe it away — and open it again.
   - It starts. Today's records are there, from the device.
   - The indicator says the sync failed rather than claiming it just
     succeeded.
   - Recording a nappy still works and joins the queue.
4. Turn the network back on and the queue drains as before.

### Taking an update

1. With the app open on the phone, change something visible — a string in
   `packages/shared/src/i18n/zh-TW.ts` will do — and bump `APP_VERSION` in
   `packages/shared/src/version.ts`.
2. `npm run dev:api` rebuilds and serves it.
3. On the phone, **start filling in a bottle**: type an amount and a note,
   and do not save.
4. Send the app to the background and bring it back.
   - A strip appears at the top: there is a new version.
   - Nothing has reloaded. The form is exactly as you left it.
5. Tap the strip.
   - The page reloads onto the new build.
   - **The amount and the note are still there.** That is the check
     (spec 2.1); anything else means a parent loses what they were typing
     every time a release lands.
6. Anything in the queue, and any unconfirmed stop, are also still there —
   they live in IndexedDB, which a reload does not touch.

Backgrounding it is not decoration. **Nothing polls.** The version check
runs when the app starts, when the browser says it is online again, and on
`visibilitychange` — there is no timer, because one would wake a phone on a
bedside table to ask a question nobody is waiting for. So the way to make
the check happen is to leave the app and come back to it.

Two signals can raise that strip and either is enough: the service worker
finding new assets, and `GET /api/version` reporting a build the running
one is not. The second is what catches a phone that has been open since
Tuesday.

## The calendar, as a timeline

**No HTTPS needed.** Nothing on this page touches the service worker, so the
LAN address is enough:

```sh
npm run dev:all
```

Open `http://<ip>:5180`, sign in, and reach it from the icon at the top left.

The page is a fixed 00:00–24:00 axis (spec 7.5). Everything below is about
whether the picture is true, which is the one thing automated tests cannot
answer: they can prove a card was placed at 09:00, not that anybody can read
it at arm's length with the lights off.

### The axis

1. Every hour is the same height, and the hours with nothing in them are
   still there. A quiet afternoon must leave a gap, not close up.
2. Scroll to both ends. **00:00 and 24:00 are both reachable**, and neither
   is under the notch or behind the bottom button.
3. On today there is a line marking the current time; on any other day there
   is not. Opening today lands near the current hour; opening an older day
   lands on its first record.
4. **Scroll somewhere else and leave the phone for a minute**, or press the
   sync line. The page must stay where you put it. A screen that snaps back
   to the current hour while you are reading last night is the failure this
   is written down for.

### Where things sit

5. Record a sleep from 09:00 to 10:00 and a bottle at 09:30 — the case
   spec 7.5 uses. The sleep occupies one hour of axis; the bottle sits
   **halfway down it**.
6. Record something very short, a couple of minutes. Its card is bigger than
   two minutes, because a smaller one could not be pressed — but the coloured
   bar down its left edge is the real length. Check the card has not become
   the duration: a two-minute nap must not look like forty minutes.
7. An all-day record (a milestone) belongs in the band **above** the hours,
   not at 00:00 under the night feeds.
8. A record with no end time that is not a running timer says the end time is
   unfilled rather than showing a length.

### Two things at once

9. Record two events a few minutes apart. They sit **side by side**, neither
   covering the other's words, and both can be tapped.
10. Record four within a few minutes. The stretch collapses to an entry
    saying how many; tap it and all four are there, each one tappable. The
    rest of the axis keeps its proportions while that is open.

### Across midnight

11. A sleep from 23:00 to 07:00: the evening shows 23:00 to the bottom of the
    day and says it continues; the morning shows midnight to 07:00 and says it
    was carried over. **Tapping either opens the same record.**
12. A sleep ending exactly at midnight leaves nothing at all on the next day.

### Local state

13. In flight mode, record a nappy. It appears on the timeline at its own
    time, marked unsynced, and tapping it goes to the unsynced list. Come back
    online: there is **one** of it, not two.
14. Start a sleep timer, go into flight mode, press stop. On the calendar the
    card says it has ended and is awaiting confirmation — **not** that it is
    still running — and it prints **the time you pressed stop**, not 08:00.
    Tapping it opens the confirmation screen.
    - Do the same across midnight if you can: start a timer late in the
      evening and stop it the next morning with no signal. The morning must
      show the dashed piece from 00:00, because the server still thinks that
      timer is running and only this device knows otherwise.
15. Turn the network off entirely and reopen the day. The events already on
    the device are still drawn; the timeline asks the server for nothing.

### The rest of the page

16. The date picker, back to today, the manual sync line and the add button
    all still work, and the add button still files under the day being looked
    at (spec 7.3).
17. **Tap a record, then come back without saving.** You land on the day you
    were reading, not on the home screen and not on today; a crowded stretch
    you had opened is still open, **and the page is still scrolled where you
    left it** rather than back at the day's first record.
    - Do the same with a record still waiting to sync, and with a timer you
      stopped offline. All three kinds of card come back the same way.
18. Switch from a busy evening to a day with nothing on the hours. The page
    goes back to the top rather than staying at the bottom with the day's one
    record out of sight.
19. Leave the page open for a couple of minutes on a busy day and then tap
    something. It should answer immediately; the clock moving must not make
    the screen heavy.

### Not in this round

Dragging to change a time, resizing a card to change a duration, and tapping
an empty slot to add are all out of scope, as is the two-day view (spec 7.6,
M4). If any of them appear to work, that is a bug.

## The statistics page

**This one does not need HTTPS.** Nothing on it touches the service worker,
so a tunnel is unnecessary — the LAN address is enough:

```sh
npm run dev:all
```

Open `http://<ip>:5180` on the phone, sign in, and reach it from the icon at
the top left: the page list has home, calendar, statistics and settings.

### What to look at

**The controls**

1. The type picker lists every event type, grouped by category.
2. The four range buttons name a **number of days — 7, 30, 183, 365** — and
   not a month or a year. They are fixed day counts (spec 7.7), and a 30-day
   range starting on 1 February really does run to 2 March.
3. Underneath them the window is written out, `2026-02-01` to `2026-03-02`.
   That line is the point of the day-count labels: it is the only thing on
   screen that can say which days are actually being charted.
4. Pressing a range button moves the whole window so it **ends today**. Check
   it on the last days of a month, where it used to be wrong: today itself
   was missing from a 30-day chart, or two days that had not happened were
   included and dragged the average down.

**The chart**

5. Switch between the bar and line buttons. Both draw the same figures.
6. Pick **weight** and a 30-day range. With only a few weighings, the
   readings must sit **on their own dates** — one taken on the 30th belongs
   at the right-hand edge, not a third of the way along because it happens
   to be the second of three points. A single reading shows as a dot.
7. Check the axis labels: every day over 7, the 1st, 5th, 10th and so on
   over 30, and month numbers alone over 183 and 365. The month markers come
   from the calendar, so a month with nothing recorded on its 1st still gets
   one.
8. Pick **sleep**. The figures read as hours and minutes rather than raw
   numbers, and the line saying the chart counts finished records only
   appears underneath. Start a sleep timer and come back: today's total does
   not move while it runs, which is what that line is there to explain
   (spec 3.4.1 rule 3).

**The states**

9. **With no network at all**, the page cannot show a chart. There is no
   cached copy of the figures — they are the server's, and computing them
   here is exactly what the app must not do (spec 5.6) — so it says it could
   not read them and offers a retry. Turn flight mode off and press the
   retry; the chart appears.
10. **Stopping the worker does not change what is already on screen.**
    Nothing re-asks by itself. After Ctrl-C, change the type or press the
    sync line to make a new request, and then the failure and its retry
    appear. Start the worker again and press the retry.
11. **The "still on this phone" line needs a record the queue is holding
    while the network works**, which is not the same as being offline. The
    reliable way to make one:
    - Start a sleep timer.
    - Turn flight mode on, and start a second sleep timer.
    - Turn flight mode off. The second one is refused for good — only one
      timer of a type may run (spec 3.5) — so it stays in the unsynced list
      with its content, and the home screen still says one record is
      waiting.
    - Open the statistics page. A line says how many records are on this
      phone and missing from the figures.
    - Pick **weight**, which has nothing to show unless you have weighed the
      baby. **The line is still there under the empty chart** — that is the
      case it matters most in, because otherwise the screen says there is
      nothing and gives no reason.
12. Press the sync line at the top. The chart asks again rather than sitting
    on yesterday's figures under a heading saying it has just synced.

**One-handed, in the dark**

13. Every control is reachable with a thumb, and the chart is legible at
    arm's length with the screen dim. 365 bars on a phone is the hard case.

### What this page cannot tell you

Nothing here measures the 10 ms CPU limit. The database times printed by
`npm run db:stats-fixture` are SQL time on a laptop with no limit applied,
and Miniflare does not enforce the Workers CPU budget at all (spec 11.2), so
no local number bears on it. That measurement needs a deployed Worker and is
listed in spec 12.1 as an M3 acceptance condition that has **not** been
carried out.

Note also that a development database holding a few dozen events makes a
365-day chart mostly zeros. That is the data being thin, not the chart being
wrong. The year of invented records lives in its own database, below, and is
deliberately not wired to the app.

### A year of data for the statistics

```sh
npm run db:stats-fixture
```

`GET /stats` is the one endpoint whose cost depends on how much history a
baby has, so there has to be a year of it to point at. This writes about
4,500 invented events across 365 days — six bottles and six nappies a day,
a weighing every Monday, a temperature now and then — and then aggregates
them and prints how long the database took and how many rows came back.

**It is not `dongfan-dev`.** It has its own configuration file and its own
database, `dongfan-stats`, because burying the handful of records you
develop against under 4,500 invented ones would make the app useless to
look at. It never reads or writes anything else, and it is safe to run
twice: it looks its own account and baby up rather than assuming they are
absent.

What it can tell you is that the aggregation happens in SQL and hands back
at most one row per day — 365 rows out of 4,500 events, in about a
millisecond. What it **cannot** tell you is anything about the 10 ms CPU
limit, because Miniflare does not enforce it (spec 11.2). That measurement
needs a deployed Worker and is still outstanding.

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
| Anything needing a deployed build | Everything above runs against the local Worker |

These stay outstanding. [`deployment.md`](deployment.md) is what to do when
deploying becomes the plan; none of it has been done.
