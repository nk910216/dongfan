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
| 7 | The single-day timeline: fixed 00:00-24:00 axis, positions and durations, overlap, drafts (spec 7.5, revised) | **done** |
| 3 | A year of synthetic data in its own database, the D1 query-count guardrail (spec 11.2), and `GET /stats` for `count`/`sum`/`last`/`max`/`avg` | **done** |
| 4 | `duration_sum`: the midnight split in SQL, `UNION ALL`, excluding running timers | **done** |
| 5 | The stats screen: type, range, chart kind, axis density, the two warnings | **done** |
| 6 | The M3 acceptance: what can be checked locally, and the steps for the rest | **done** |

**M4 is in progress**, in stages, each reviewed before the next. The order
follows the dependencies and the risk, not spec 12's list: the tag write path
carries a rule that fails silently on other devices, so it gets a stage of its
own rather than being folded into a screen.

| | | |
|---|---|---|
| 1 | The two-day calendar (spec 7.6), on the single-day timeline | **done** |
| 2 | Renaming and deleting a tag: the `rev` bump before the association goes (spec 7.9) | **done** |
| 3 | Tags on an event, in the add and edit forms (spec 7.3) | **done** |
| 4 | The tag page: filtering `GET /events` by tag, with paging (spec 7.9) | **done** |
| 5 | Data export: the endpoint and the settings entry (spec 5.1, 12) | |
| 6 | The M4 acceptance: what is checkable locally, and the phone steps | |

**Stage 2 is done.** See "A tag write is an event write" below.

**Stage 2 was the one to be careful with.** Incremental sync only watches
`events.rev` (spec 5.4), so deleting a tag by removing its `event_tags` rows
leaves every other device showing a tag that no longer exists -- for ever, and
without a symptom. The bump has to come **first**, in the same transaction,
because the numbering SQL finds the affected events *through* the associations
it is about to delete. Renaming a tag and attaching or detaching one on an
event carry the same rule.

What exists already: `GET`, `POST`, `PATCH` and `DELETE` for tags, tags on
the add and edit forms, and the tag page with its filter. The export is
absent.

### A tag write is an event write

Renaming or deleting a tag has to move **every event carrying it**, because
incremental sync watches `events.rev` and nothing else (spec 5.4). A rename
that touched only the `tags` row leaves the other phone showing the old name
for ever; a delete that removed only the `event_tags` rows leaves it showing
a tag that no longer exists. Neither has a symptom on the device that did it.

**The order is the whole of it**, and all three are one `batch()`:

1. bump the revs, **while `event_tags` still has the rows** -- the numbering
   SQL finds the affected events *through* the associations;
2. delete the associations;
3. delete the tag.

Reversed, step 1 matches nothing and the change never syncs.

**`BUMP_REV_FOR_TAG` in `lib/events.ts` is the only spelling of a batch
allocation**, beside `NEXT_REV` for a single row (spec 5.4 rule 3). It is a
window function because both obvious alternatives are wrong: a shared
`MAX(rev) + 1` gives every row the same number, which makes pagination drop
whatever did not fit in the page a client happened to read, for ever; and one
`UPDATE` per event blows the fifty-query budget as soon as a tag is on fifty
records, which is an ordinary number for a tag.

`version` is **not** bumped, only `rev` and `updated_at`, which is what
spec 7.9 asks for. Bumping it would turn every unsent edit draft on the other
phone into a conflict over a change that touched nothing the draft holds.

Renaming to a name the baby already has answers `TAG_NAME_TAKEN` rather than
merging the two: merging is a destructive guess at what was meant. Renaming
to the name it already has is a no-op that moves nothing, because a sync for
no change can be a long list.

**That check is not a lock, and the write says so.** Two parents renaming two
tags to the same word both pass it and one meets `UNIQUE(baby_id, name)`,
which was answering 500 until review found it. Which constraint failed is
decided **by asking the database**, exactly as the event routes do: message
formats are not a contract, and reading one wrong would turn every database
fault into "that name is taken".

That race is also where the batch rollback is finally observable. The loser's
rev bump runs before its rename fails, so if D1 did not unwind, its events
would carry new revs for a rename that never happened -- and the other phone
would sync a change that does not exist. `tags.test.ts` asserts the loser's
`rev` and `updated_at` are untouched.

**The response comes from what the write touched, never from the read before
it.** `meta.changes` on the last statement decides it. The delete has no read
in front of it at all -- whether the tag existed is one query cheaper as an
answer from the write, and a read could only be stale by the time the write
ran. The rename still reads, because it needs the current name to know
whether this is a no-op and whether another tag holds the new one.

The interleaving that guard exists for -- a delete landing between the read
and the write -- **is** testable, and a note here previously said it was not.
`Promise.all` cannot produce it, because this runtime settles one request
before the other reads; holding the delete until the rename's batch is about
to run can, with real D1 throughout. What is controlled is when the other
request happens, not what the database does with it.

### Every statement in a tag batch is scoped to the baby on the path

`meta.changes` on the last statement decides the **response**. It does not
undo the statements before it, and putting the only ownership check there was
a P1: a tag id belonging to another family, sent to this baby's path, had its
associations deleted and its `event_tags` rows gone -- and the answer was
404, so nothing anywhere said it had happened. The rev did not move either,
so the other phone would never have been told. That was introduced by
dropping the delete's read, which had been carrying the check by accident.

So `DETACH_ALL` and `BUMP_REV_FOR_TAG` both carry the path's baby id, and the
allocator binds it four times. The allocation is the worst place to be loose:
its base is that baby's `MAX(rev)`, so applied to another baby's events it
would hand them revs from an unrelated sequence and break the cursor for
both.

### Tags on a form travel with everything else

The list is **on the device**, synced with the events and kept in IndexedDB,
because a form has to offer them with no signal. `syncTags` replaces it
wholesale -- no cursor, no merge -- which is the other half of spec 7.9: the
events learn through their revs that their tags changed, and this is how the
device learns what the tags now *are*, including that one of them is gone.

**Chosen tags are part of the queued entry, not something applied
afterwards.** `NewEventInput.tagIds` goes to the server with the record. Sent
as a second step it would be an edit, which the queue does not take
(spec 6.1), so a feed written up offline and tagged "night" would simply
arrive untagged. Entries and drafts written by a build before the field
default to none, read back rather than migrated -- `readForm` completes a
stored draft once so none of the three screens that read one has to remember.

**Making a tag needs a connection; choosing one does not.** A tag minted on
the device would carry an id the server never agreed to, and two phones
inventing one for the same word would make two tags. So the picker offers
what has been synced and says plainly that a new one needs to be online.

**An edit sends the whole list under the event's version**, so a conflict
leaves the event and its tags both exactly as they were (spec 4.3) -- and the
screen keeps what was chosen rather than throwing it away, because being told
to look again is not a reason to lose somebody's work (spec 2.1).

**An absent tag list and an empty one are different, and storage keeps them
apart.** A draft written before tags existed has *no opinion* about them;
one this build wrote with `[]` chose none. `StoredDraft` leaves `tagIds`
optional and `readForm` returns it as stored, so each screen decides what the
absence means: none on the add form, the record's own tags on the edit form.

This note previously claimed the second half while the code did the
opposite. `readForm` filled the gap with `[]` "once, so nobody could forget"
-- and the edit screen applied that, so saving an old draft sent an empty list
and took every tag off the record. Its own comment said reading a missing
field as empty "silently strips something". Found in review; completing a
value at the one place that cannot know what it means is not the same as
handling it.

The stop confirmation sends no `tagIds` at all, which the API reads as "not
being changed".

### An answer that arrives late acts on the form as it is now, or not at all

Making a tag waits on the server, and the form does not stop while it waits.
The picker's handler held the props of the moment the button was pressed, and
`onChange` from that moment carried the whole form as it was then -- so the
answer put the entire form back and silently undid a note typed meanwhile,
and an amount, and another tag. Found in review. The picker now applies the
answer through the props of *now*.

Two more fell out of following that mechanism, and both were worse:

- **After the form is gone**, the same answer wrote the old content back as a
  draft, and the next form of that type opened holding it. The picker does
  nothing once unmounted; on the edit screen that is the only defence, and
  its test is there.
- **While the record is being sent**, the draft carries the id it is going
  out under, which is what stops a reload turning one record into two
  (spec 3.8). The fieldset freezes the fields for that reason, but **a
  fieldset stops taps, not answers**: the late tag rewrote the draft without
  its mark. The add form now has a lock, a ref set in the same tick the mark
  is written and released only by a refusal, and every write to the draft
  checks it -- the intent toggle too, which sits outside the fieldset.

The rule underneath all three: **anything asynchronous that writes back into
a form has to ask whether the form still accepts writes, and what it holds
now.** Disabled controls answer neither question.

**And "failed" is not "not written".** The lock first opened on every failed
submit, and a failed submit includes a lost answer -- the server may well
have the record, and the content is the queue's until that is settled. The
intent toggle, outside the fieldset and checking only the lock, then rewrote
the draft without its mark while the screen was saying the outcome was
unknown. Found in review. `SubmitResult`'s `failed` had a doc comment saying
"the server refused it" while every error landed there; it now carries
`inDoubt`, **read back from the queue entry** rather than inferred from the
error, because the queue is what decides whether a record may be resent and
a second classification would drift from it. The lock opens only on a
refusal.

Every write to the draft goes through one predicate, `writable()`: the lock
for this session, the queue's `outcomeUnknown` for after a reload. The toggle
is also disabled whenever the fields are. What the tests pin, stated
exactly: the toggle being disabled in doubt, and the pair of halves together
(a late tag answer into a record in doubt). Neither half alone is
observable -- the queue's is only ever alone behind controls that are already
disabled, and the lock's matters only in the gap between hearing the failure
and the doubt reaching the screen. Both are labelled where they sit.

The edit screen has no lock and no fieldset, so typing during an edit's save
is possible and what is typed then is not part of the PATCH. That predates
tags and is not fixed here.

A tag the other parent deleted while a form was open stays selected and has
no chip to show for it, and it is sent: this device cannot know it is gone
until it syncs, and silently editing what somebody chose is worse than
sending something that turns out not to exist.

**The server refuses it**, with `VALIDATION_FAILED` and `tagIds.N:
INVALID_ENUM` -- it does **not** drop it. This note said "the server drops
it" until stage 4, and it was never true of the API: `unknownTags` in the
events route has refused unknown ids since M1. The claim came from the MSW
mock, which filtered them out, so the web suite was testing a contract that
did not exist. The mock now refuses as the API does.

What that cost: a record written offline with a tag, waiting in the queue
while that tag is deleted, is refused for good when it is sent -- and its
correction form could not fix it, because the picker drew only tags the
device has, so the deleted id was selected with no chip to un-select.
Abandoning the record was the only way out.

**The owner chose to make it removable, not to make the server lenient.**
The picker now draws a selected id it has no tag for as "deleted or
unavailable", and tapping it takes it off through the form's ordinary
`onChange`: the correction then resends under the same event id with every
other field as it was, and while an outcome is unknown the fieldset freezes
it like everything else. The server still refuses an unknown tag; quietly
dropping input to get round a dead end in the interface was ruled out. The
delete sheet on the tag page still warns when this phone holds such a
record, because the record does still need somebody to open it.

**Deleting a tag is not reference-counted.** Every association goes, which is
what spec 7.9 describes and what the tag page's confirmation is about.

### The tag page, and the filter under it

`GET /babies/:id/events?tags=` is the tag page's question, told apart from
the incremental sync by `tags` being present; sending a sync cursor with it
is refused rather than half-honoured. It answers `{ events, total, hasMore }`.

Three ways the filter loses or repeats a record with every response a 200,
and each has a test that fails when the guard is removed:

- **A record carrying two of the chosen tags joins twice.** `DISTINCT` makes
  it one row, and it is applied **before** `LIMIT`/`OFFSET`. Paging over the
  joined rows counts the duplicate against the page, which comes up short,
  and the next one starts too late.
- **The order has to be total.** `started_at` alone is not -- two nappies in
  the same second are ordinary -- so `id` breaks every tie, in the same
  direction as the sort. The test that pins it checks the order of seven
  records sharing one instant; SQLite happens to return ties consistently
  here, so dropping the tiebreak shows as a wrong order rather than as a lost
  record, and it is the order that is asserted.
- **The tag list is one bound parameter**, a JSON array read with
  `json_each`. Bound one by one, a hundred ids plus the baby and the paging
  is over D1's limit (spec 4.2), and the test asking with a hundred answers
  500 when that is tried.

The page, its tags and the count are one `batch()`, so `total` and `hasMore`
describe the same moment as the rows -- and `hasMore` comes from the total,
not from "the page was full", which is wrong exactly when the last page is.

`AND t.baby_id = e.baby_id` on the tag join cannot change a result today:
associations only ever join a tag to an event of the same baby, because the
write path checks it. It is there so a foreign tag id selects nothing by
construction rather than by an invariant held in another file, and removing
it passes every test. Said here rather than counted as covered.

**Offsets are positions in a list other people can change.** Spec 7.9 asks
for `limit`/`offset`, and with it a record added at the top between two pages
pushes the one at the boundary onto the next page as well; a record deleted
above the boundary pulls one back past it, and that one is never shown. The
screen drops the first by id. **The second it cannot see.**

The owner chose to keep spec 7.9's offsets and say so rather than move to a
cursor: for one family's records the gap is narrow, and a cursor does not
give a complete snapshot either once a record's time or tags change between
pages. What the screen offers instead is a refresh beside the count, which
asks again **from the top** as long as what is showing -- the one request
that brings a skipped record back. A test deletes a record between two
pages, shows the skipped one missing, and shows the refresh restoring it.

**Two requests can fail here, and they are two facts, kept apart.**
`stale` says the last ask from the top failed, so the rows are older than
the server's; **only an ask from the top that succeeds clears it**.
`moreFailed` says the next page failed, and is retried as that page. Both
carry the query they are about. They were one value until review found,
twice, what that costs: a failed "more" overwrote a failed re-ask, and a
"more" that then succeeded left unrefreshed rows on screen with nothing
saying so. A test walks exactly that sequence -- re-ask fails, "more" fails,
"more" succeeds, the warning is still there; the ask from the top succeeds,
it goes. The retry used to be chosen by whether rows were showing,
so a re-ask that failed after a sync was retried as "more" -- offset 1, the
error gone and the old rows never asked for again. Found in review. The
first version of the test for it passed with the bug in, because a later
re-ask from the sync machinery fixed the list up on its own; it now asserts
the request the button sent, not what the list eventually shows.

The screen keeps the choice, the order and the range **in the address**,
because opening a record from the results unmounts it. An answer to a query
that is no longer the one on screen is dropped, and so is a "more" whose
question has moved -- stage 3's rule, for a list. A re-ask after a sync asks
for as many rows as are showing, so catching up does not shorten the list
somebody had scrolled down.

**What is chosen is filtered to the tags the device has.** That one rule is
how a deleted tag leaves the choice, whether this phone deleted it or a sync
said the other one did; an explicit un-choose on delete was a second
mechanism nobody could see working, and it was removed.

The delete sheet asks the **server** how many records carry the tag, because
the claim is about every record and the device may not hold them all. Until
the count is in, the delete is not offered; if it cannot be had, the sheet
says so and still does not offer it -- "not in use" on a failed request is
the worst wrong answer the sheet could give. Records in this phone's queue
are counted and said separately, since the server cannot see them (see the
deleted-tag gap above). A delete that meets `NOT_FOUND` says the tag was
already gone rather than claiming the deletion, after the sync has taken it
off the list.

After a rename or a delete the store syncs, because the records learn of the
change only through their revs (spec 7.9). A test reads the device's own copy
of a record after a delete, not the edit form: an id with no tag to draw has
no chip, so the form looks the same whether the sync happened or not.

The rename also writes the new name into the stored list before that sync,
so the screen is right at once. Not separately observable -- the sync
straight after brings the same name -- and not counted as covered.

### Two days, one set of hours

Spec 7.6's point is comparison -- last night against tonight, this
afternoon's naps against yesterday's -- and that only works if the columns
share a scale. So there is **one** axis of hour labels and the days are two
bands drawn over it at the same `hourHeight`. Two columns on two scales would
be two charts side by side, which is not the same screen.

The chosen date is the **right-hand** column and the day before it is on the
left: oldest first, which spec 7.6 asks for and which is the order a night
reads in, beginning on the left and ending on the right. Each column has its
own all-day band, because an all-day record belongs to one of the days rather
than to the pair.

**A crowded stretch is named by its day as well as its minute.** Both columns
have a 09:00; keyed on the minute alone, opening one opened the other and
closing either closed both.

**Both ways out of a screen decide it in one place.** The nappy shortcut had
two: the ordinary one knew about `from` and the one that hands over to the
edit screen did not, so a shortcut that turned into an edit left the two-day
view while the shortcut beside it came back to it. That hand-over happens
when the queue sends an entry the screen had taken over -- the record is the
server's by then, so it cannot be posted again (spec 6.1, 6.3).

Reaching it in a test is awkward and worth knowing: the shortcut only takes
over an entry that is **in doubt or failed**, so it needs a nappy whose answer
was lost, and then the queue getting through while that screen is open --
which is five seconds of backoff away. The test moves the clock rather than
waiting, the same way the statistics one pins the current time.

**Adding from here carries where it came from.** The day a record is filed
under and the screen somebody is looking at are two questions, and only the
first travelled: `dayView` names the single-day calendar, so the nappy
shortcut, saving the form and cancelling the type picker all left the two-day
view. `addQuery` writes both, and every link in the chain uses it. The home
screen and the single-day calendar say nothing, so nothing changes for them --
which has a test, so the chain cannot be "fixed" by sending everything to the
same place.

`Timeline.tsx` was split for it. A day's cards live in a `DayBand` positioned
by whoever is drawing it, and their geometry is percentages **of that band**;
the hour labels' strip belongs to the band's offset, not to each card. The
single-day screen is one band from the gutter to the right edge, and the
two-day screen is two halves of the same space. Nothing about placement,
sizing, overlap or where a tap goes is duplicated -- both screens run the
same `itemsFor` and `layOut`, and `useDay` reads a day the same way for both
so they cannot develop separate ideas of what one contains.

Spec 7.10's page list names all six of its pages and marks the one showing,
with a word as well as a colour. The tag page joined it in stage 4 and was
left out until then rather than listed and dead.

### A day's calendar is a timeline, not a list

Spec 7.5 is now explicit: the page is a **fixed 00:00-24:00 axis**, every hour
the same height, and an empty stretch stays empty. Nothing compresses a quiet
afternoon or stretches a busy hour, because the shape of a day — where the
gaps are, how long the night was — is the thing the page exists to show. A
layout that tidied that away would be a list with gridlines drawn on it.

"Event UI the same as the home screen" in that section means the colours,
icons, content format and status wording, **not** the home screen's list row.
`components/EventRow.tsx` is still shared by the home screen and the unsynced
list; the calendar draws its own cards, and that is the spec's intent rather
than drift.

**Two measurements per record, and they are different numbers.** The anchor
and the bar are real: a twenty-minute nap is twenty minutes of axis. The card
carrying the words has a minimum height, because a tap target smaller than a
fingertip is no use at three in the morning — so it is drawn *beside* the bar
rather than *as* the bar, and its height can never be read as a duration. That
is the trap spec 7.5 names, and `timeline.test.ts` pins both halves.

**Overlap is decided on the card's extent, not the duration.** Both kinds the
spec names are then the same problem: ranges that genuinely intersect, and two
bottles four minutes apart whose cards would sit on top of one another.
Columns are assigned greedily and a column is reused as soon as the card above
it has finished. Past three at once there is no width left for words, so the
stretch offers an "N of them" entry that expands — and every one of them is
behind it, because nothing may be silently dropped.

### Which day a record belongs to has not changed

`calendarDay` still decides that, and the timeline adds nothing to it: the
night before that ran into this morning is included, an unfinished event
appears only on the day it started, and no query was widened for the redesign
(spec 7.5 says so in as many words). Duration statistics were not touched.

**Records still in the outbox follow the same clipping**, because they are
the same records; the only difference is who has heard about them. Filtering
them on their start day alone made a night written up offline disappear from
the morning it covered.

- `eventsOnDate` — what is **counted** on this day. The home screen shows
  this, because the figures printed beside it are computed the same way.
- `calendarDay` — what was **happening**: the above plus whatever ran into it,
  each entry saying whether it was carried over.

A completed event draws only the part that falls on the day being looked at,
and tapping either half opens the same event. Ending exactly at midnight makes
no zero-length piece on the next day — the closed-interval rule for day
queries does not mean the midnight end is drawn twice.

An unfinished event contributes **zero length** everywhere, including its own
day (spec 3.4.1 rule 3), and zero length is not absence: it still has a time
marker. A back-filled record with no end time says so rather than being given
a length nobody entered.

A timer stopped here and not yet confirmed is drawn **ending where the button
was pressed**, dashed, leading to the confirmation screen — not as a timer
still running, because a parent who cannot tell those apart either stops it
twice or leaves it going all night. If the draft asks for longer than an event
may be, the card says the time needs correcting rather than offering a
confirmation that cannot succeed.

### The card is the record, and its top edge is the time

`docs/timeline-design.md` is the redesign this came from; it has the numbers,
the sketches and the reasoning. What follows is what a reader of the code
needs to know.

**Two marks on a card, and no more.** Its **top edge is the start minute**,
for everything, with no offset and no exception; and **colour inside it is
duration**, so a card with no colour in it is a moment. There were four marks
before -- a dot on the edge, a stripe down the left, the top edge and the
tint -- saying the same two things twice each, and marks that have to be read
together read as debris. The owner reported them as ugly and hard to tell
apart, which is the same finding.

Before that the mark lived *inside* the card, where a rounded corner and
`overflow: hidden` clipped it into a speck, and then in a lane of its own
beside the card, where it and the card were one record drawn as two objects.
The history is here because both looked reasonable when written.

**And the tint stops where the record stops.** A card has a minimum height
because a target smaller than a fingertip is no use at 3am, so a thirteen
minute nursing gets a 44px card. The colour ends at thirteen minutes and the
rest of the card is plain, which is why its height cannot be read as its
duration. When the extent covers the card this degenerates to a flat tint --
one rule, no branch.

**An hour is 96px, and that is a correctness number rather than a taste.**
At 64px an hour the 44px minimum covered **41 minutes of axis**, so two
records half an hour apart -- with nothing whatever between them -- collided
as cards, were laid out as though simultaneous, and joined the same cluster.
That spurious collision is the fuel for the collapse described below. At 96
it covers 27.5 minutes. The cost is a day 2304px tall instead of 1536.
`timeline.test.ts` pins the constant *and* the pair it exists for: a 05:40
bottle and a 06:10 nappy are two clusters at 96 and one at 64.

**A narrow card drops words; it does not disappear.** `minCardWidth` was 128
-- the width for a badge, a name, a value and a clock on one line -- and
requiring all four is why half a phone read as "no room". It is 48 now, and
`tierFor` decides what a card says at its width. The **type badge goes last**,
because with five near-identical teals and four near-identical purples in the
palette, colour identifies a family and only the glyph identifies the type.
The **clock never goes**: a timeline that has stopped saying when has stopped
being a timeline.

**A collapsed entry has to say what is inside it.** "6 records" is the same
sentence for six nappies and for a bath, a feed and four moods, and the same
for four minutes and for seven hours. The entry carries the badges of the
types inside it in start order, the count, the stretch it covers, and a
stripe segmented one colour per member. It is `surface` rather than a tint so
that nobody reads it as a record.

### Ranges and moments are two different layout problems

`Cluster`, `crowded`, `MAX_COLUMNS`, `columnSpan` and `columnsFor` are gone,
and with them the failure they caused: a cluster was a transitive chain of
**card boxes**, `crowded` was decided for the whole chain, and four crowded
minutes around 17:24 therefore collapsed 17:52 to 23:11 into one button. The
records were not merged because they were close together. They were merged
because something else was close together, three hours earlier.

`layOut` now returns `spans`, `pins` and `chips`:

- a **block** is a record whose card height *is* its extent -- long enough
  not to be pushed up to the 44px minimum;
- everything else goes in the other lane: moments, running timers,
  back-filled records with no end, **and ranges too short to fill a card**.

**The line is "is the card's size a fact", not "does it have a duration".**
A five-minute nursing gets a 44px card covering 27.5 minutes of axis, and
that size is a fact about a fingertip exactly as a moment's is. Laying it out
by its real minutes drew two five-minute feeds ten minutes apart in the same
column with 28px of one card on top of the other -- found in review, with a
reproduction. The line matters because of what it buys: **when a card's
height is its duration, records whose times do not intersect have cards that
do not intersect either**, so nothing else has to be checked. It is also the
same line that decides whether the tint fills the card.

A short range is laid out among the moments but **may never be folded into an
entry** (spec 7.5): where it is drawn and whether it can be hidden are
different questions.

**Two spans are concurrent when their times intersect. Never their boxes.** A
pin's box is 27.5 minutes because of a fingertip; a span's extent is a fact,
and an artefact must not narrow a fact. Only that rule can be told apart from
the old one by a range **shorter than 27.5 minutes**, so the test that pins it
uses a ten-minute nursing and a fifteen-minute walk twenty minutes apart --
the first mutation of this rule survived a suite full of hour-long naps.

**Spans never merge, at any width.** Concurrent ones share the band equally
within their group, longest in the first column. The cost, taken knowingly:
an eight-minute feed inside a three-hour night halves the night for its whole
length. A per-slice width would use the space better and be much harder to
reason about.

**Only records with no duration merge, and a merge is bounded three ways**:
by the clock hour, by kind, and by necessity. An eight o'clock record can
never be behind the same entry as an eleven o'clock one -- the hour is a
bound a parent can see on the axis rather than a number in the code. Two
moments either side of an hour boundary therefore never merge however close
they are, which is the price of that.

A whole hour folds at once, busiest first, one hour at a time and only while
the columns do not fit. "That hour was too busy to draw" is a sentence with a
visible boundary; "the last two of that hour" is not.

**Every tight stretch is asked, not just the first.** A stretch with nothing
foldable in it -- five short ranges, which may never be folded -- used to end
the search, so a crowded eight o'clock left nine o'clock in five 35px columns
with no entry at all. One stretch that cannot be helped says nothing about
the next.

**And it folds for the whole day, not for the stretch that ran out of room.**
Two huddles forty minutes apart do not overlap, so `groupBy` separates them --
and folding each separately made two entries both named `${day}@h9`, so
pressing either opened both, one over the other. An hour is one entry.

**An entry collides at the height it is drawn at.** It carries three rows
whatever stretch it covers, so five records in one minute is still 58px on
the screen; computing collisions from 44px while drawing 58 put ten pixels of
it over the next card. `CHIP_HEIGHT` lives in `timeline.ts` and the screen
uses `chip.height` as it is -- there is one number and the renderer may not
add to it. Both found in review.

**Nothing is ever stacked.** Columns are assigned greedily over real
intervals, so two cards share a column only when they do not overlap; when
there is not enough width the columns get narrower than `minCardWidth`.
Putting a record that found no column back into the last one regardless --
which is what the first version did when an hour had a single leftover --
came out as two nappies four minutes apart with identical geometry, one
entirely on top of the other. Found in review.

**A pin may not cover a span's stripe, its badge or its words.** `SPAN_KEEP`
(44px) keeps the first two; `labelWidthFor(band)` keeps the third -- 96px
floor, 42% of the band, 150px cap. The floor is what a two-day column can
spare; the proportion is because 96px on a 346px screen left a five-hour
nursing unable to say five hours on a card nearly two hundred pixels wide.
The fixed reservation is also what stops rule 11 being circular: the tier
depends on the coverage, the coverage on how wide the pins are, and the pins
on the tier.

**A card drops what it cannot hold whole.** `textWidth` estimates a string's
width -- CJK at one em, Latin at about half -- and anything that would be cut
is left out instead. "1 ..." where a duration should be says less than
nothing, and a name cut to one character beside a badge that already said the
type is the state this redesign started from. The clock is the exception: it
is truncated rather than dropped, because a timeline that has stopped saying
when has stopped being a timeline.

`assignColumns` keeps a real interval list per column rather than one "last
bottom" each, because spans are placed before pins and items no longer arrive
in start order.

**The band is measured off the element, never taken from the window.** `App`
is `max-w-md` and centred, so on any screen wider than 448px the window is
not the container: at 1024px the two-day layout believed each column had
490px when it had about 202, and the reserve, the column count and which
words to drop were all decided on that number. `useMeasuredWidth` observes
the scroller. jsdom performs no layout, so `test/setup.ts` stubs
`ResizeObserver` the way it already stubs `matchMedia`, and it reports the
*shell's* width rather than the window's -- which is what lets a test set the
two apart and catch this.

**Nothing may be placed past the edge of the band, and a test says so at
every width.** The reserve a pin leaves for a range is clamped to what the
band actually has; before that, asking for more than there was and widening
the columns to the minimum anyway put records up to 43% past the right-hand
edge. On a real iPhone that is a screen you have to swipe sideways to read,
and it was reported from one -- **jsdom's window is 1024px, where the reserve
never binds, so the whole suite was green.** Both calendars also clip
horizontal overflow, so the next mistake in this arithmetic shows up as a
truncated card rather than as half a day off-screen. Any test about how this
screen is laid out has to name a phone's width; the default is a desktop.

**An expanded entry takes the whole day band**, not the column its entry sat
in. It is a layer over the day rather than a record in it, and an entry's
column can be 54px -- where its rows were being laid out as though they had
the band, so every one of them overflowed. Found in review.

**The `?open=` key is `${day}@h${hour}`**, not a minute. The day is in it
because both two-day columns have a 09:00; the hour replaced the minute
because a minute moves when a record is added nearby, which silently closed a
list somebody had open.

### The clock ticks every second, so nothing may depend on it by accident

`now` in the store moves once a second. The timeline passed it straight
through, so every card on the day was re-rendered once a second -- sixty times
a minute -- for a line that cannot move by less than a pixel in that time.
`nowMinutes` is whole minutes now, and the hour rules and each cluster are
memoised.

**That is unnecessary work removed, not a diagnosis.** A React render is not a
repaint, and no measurement was taken: when jank was reported on a real phone
this was found by reading the code, and it may or may not have been the cause.
Do not write it up as one without a profile or a phone that got better.

### Where a screen goes back to

`lib/return-to.ts`: a `?from=` in the query string, not router state and not
`navigate(-1)`. State is lost on a reload and the history has nothing to go to
when a link was opened directly.

The edit screen went to the home screen from everywhere. Opening a record from
the calendar and coming back therefore landed on home, on today, with whatever
had been opened on the day being read closed again -- which is what a crowded
stretch collapsing "by itself" actually was. Whether such a stretch is open
lives in the URL for the same reason: the component that held it is unmounted
by the navigation.

**It has to be carried the whole way, not just the first step.** Correcting a
queued record goes calendar → unsynced list → correction form → and, if the
queue sent the original while the form was open, on to the edit screen. Each
of those was a separate place to drop it, and dropping it at any one of them
put somebody back on the home screen at the moment they had just finished
dealing with the record -- which is what they opened the list to do. A
correction has no day of its own, so it returns to wherever it was opened
from; falling back to home is what reaching the list from the home screen's
own strip already does, and nothing is invented when nothing said otherwise.

Cancelling a correction goes back the same way rather than to the type
picker. There is no type to choose again.

**All three kinds of card carry it**, not only the ordinary one. A queued
record goes to the unsynced list and a stop draft to the confirmation screen,
and both of those returned home while the card beside them came back to the
day -- so the same timeline behaved differently depending on what state a
record happened to be in. Both screens take `useReturnTo()` and fall back to
home when nothing said otherwise, which is what reaching them from the home
screen's own strips does.

**And where the day was left is remembered** for as long as the app is open,
in module state rather than a ref, because the point is to survive the screen
being unmounted. Coming back is not a first visit: re-deciding dropped
somebody reading last night's cluster back at the morning's first feed, with
the list they had opened still open and somewhere off the screen. A reload
forgets, which is right -- that is a fresh look at the day.

### The preview harness

`packages/web/preview/` draws the timeline from invented fixtures, with no
store, no account and no database. `npm run dev` serves it at
`/preview/timeline.html?view=day|two&at=<hour>`; `vite build` takes
`index.html` and nothing else, so none of it ships.

It exists because every failure this screen has had is geometric and **jsdom
computes no geometry**. A mark clipped into a speck, words an hour below the
line they belong to, a type name cut to one character and a six-hour block
with a number in the middle of it all pass every assertion in the suite. A
test can say a card is 44px tall; only a picture can say it is unreadable.

Chrome's `--window-size` is clamped to about 500px wide on macOS, so a
screenshot at a phone's metrics needs `Emulation.setDeviceMetricsOverride`
over the DevTools protocol rather than a window of that size. A jsdom test is
not a visual acceptance and must never be reported as one.

### Four ways the timeline was wrong and looked right

All four passed every test that existed, which is the point of writing them
down.

- **Cards ran off the right-hand edge.** The hour labels take a fixed strip
  off the left; the offset added it while the widths still divided the *whole*
  container, so a single column ended 40px past the edge and so did the last
  of any row. Columns are fractions of the **event area** now (`columnSpan`),
  and the screen subtracts the strip once in a `calc`.
- **A stop draft printed 08:00.** The card read `endedAt` off the event, but
  the event the server knows about is a running timer with no end at all, and
  a null formatted as a clock is the epoch in Taipei. The draft's own moment
  travels on the item.
- **A queued add that crossed midnight lost its morning.** The outbox was
  filtered on "starts on this day", so a sleep written up offline from 23:00
  to 07:00 was invisible on the morning until the queue drained, and then
  seven hours appeared from nowhere. It is clipped to the day exactly as a
  stored event is, midnight end strictly excluded.
- **Switching dates positioned against the day before.** The read is
  asynchronous, so for a moment the previous day's rows are still in hand;
  the effect laid those out under the new date, scrolled against them and
  marked the date as done, so the right rows arrived to a page that had
  stopped listening. The rows now carry the date they were read for, and
  anything else counts as not loaded yet.

### A stop draft is an ending, as far as this device is concerned

`calendarDay` asks `endOf`, which is the draft's moment when there is one and
the event's own end otherwise. Without it, a sleep begun at 23:00 and stopped
at 07:00 with no signal had no end at all as far as the day query was
concerned -- the server still has it running -- so the morning it covered
showed nothing, and seven hours appeared once the confirmation went through.

**A running timer with no draft keeps the narrower rule**: it belongs to the
day it started on and to no other, because its length is not a fact yet
(spec 3.4.1 rule 3). The two are separate tests, because widening the second
by accident is the easier mistake.

### Scroll position belongs to whoever is holding the phone

Today opens near the current hour, any other day opens on its first record,
and a day with nothing on the hour axis -- empty, or only a milestone in the
band above -- goes to the top. Leaving the scroll alone there kept the page at
the bottom with the day's one record out of sight. All of it **once per day
looked at and never again**. Spec 7.5 is explicit that a
background sync or the clock ticking must not keep taking the position back:
somebody reading last night's feeds at 3am would find the page snapping to the
current hour under their thumb. The current-time line is on today only, from
the baby's clock rather than the device's.

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

**The midnight split is done in SQL**, as `UNION ALL` over "before midnight"
and "after midnight" (spec 5.6). Two parts are enough only because an event
lasts at most 24 hours and so crosses midnight at most once (spec 3.4.1
rule 1) — that invariant is enforced when an event is written, and a row
breaking it would have its whole tail attributed to the following day.

The boundary is the start of the day after the one the event is filed under.
SQLite's `unixepoch` gives UTC midnight of a date and the baby's offset turns
that into a local one, so one bound number does the whole range.
`offsetFor` is an **allow-list, not a detection**: it serves the zones
spec 5.3 declares fixed-offset — `Asia/Taipei` alone in v1 — and refuses
anything else. An earlier version compared the offset at the two ends of the
range instead, which looks like a safety net and is not one: a range from
June to June spans two transitions and has the same offset at each end, so it
would pass while every night on two days of the year was split an hour out.
Nothing reaches the refusal today, since a baby's timezone is validated
against the same list, and it promises nothing about detecting a transition.

**The lower bound is a day earlier than asked for** (spec 3.4.1 rule 2), and
the segments are filtered back to the range *after* the split. Without it,
asking about this morning loses the seven hours of sleep that are filed under
last night, and says nothing about it.

Durations are summed in milliseconds and converted **once per day** through
the shared `msToMinutes`, so the API and the app round the same way and three
forty-second naps are two minutes rather than zero (spec 5.3). The unit is
`min`, never milliseconds and never the type's value unit — a duration type
has no value spec to take one from.

**Two conditions in that query are not observable, and saying so is the
point.** `ended_at IS NOT NULL` changes nothing, because `MIN(NULL, boundary)`
is NULL, NULL minus anything is NULL and `SUM` skips it — SQLite already
leaves unfinished events out, and removing the condition passes every test.
The final `WHERE date BETWEEN` cannot change a response either, because
`withGaps` builds the points from `from` to `to` and never looks at a row
outside it; what it does is bound the rows crossing from the database to the
Worker, which is the number spec 5.6 caps at 366. Both stay, both are
labelled in place, and neither is counted as covered.

**`avg` has no configured type.** Every aggregation in the event type config
is `count`, `sum`, `last`, `duration_sum` or `max`. `avg` is implemented
because spec 5.6 names it, and its SQL runs on every request alongside the
others, but the branch that *selects* the mean cannot be reached through the
endpoint and therefore has no end-to-end test. Said here rather than left
looking covered.

### A failed Zod refinement does not stop the next one

`.refine` marks a result **dirty**, not aborted, so every refinement after it
still runs — with the raw, unvalidated value still in place. A range check
chained after a date check therefore ran on `"invalid"` and threw out of
`safeParse` instead of returning a failure, and the route answered **500** to
a plainly bad request.

`parseLocalDate` throwing is correct and stays: it says "somebody passed this
something that is not a date", which is a bug. The bug was calling it with
something unvalidated. Anything downstream of a `.refine` re-checks what it
depends on, and `statsQuery` does that with an early return in a
`superRefine`.

`2026-02-31` does **not** exercise this: it parses perfectly and is merely a
day that does not exist. The tests name several strings that do not parse at
all, because the one that was there caught nothing.

### The D1 query-count guardrail

`test/query-count.ts` wraps the binding and counts every statement a request
executes, failing past 30 (spec 11.2). The free plan allows 50 per
invocation and **the local runtime enforces none of them**, so a handler that
had quietly become N+1 would pass every other test and fail in production
against a baby with a year of records.

**It is wired into `helpers.ts`'s `request`, so every test in the API suite
enforces it.** It first existed as an assertion in one stats test, which
meant an N+1 anywhere else went through CI untouched — and a guardrail
nobody has to remember to ask for is the only kind worth having
(spec 13.3). Every existing endpoint already fits.

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

**And it checks that what is there is a whole year, not merely that
something is.** The insert goes in chunks, so a run that died between them
leaves a few hundred events behind; a guard of "more than none" then skipped
filling and printed timings for a fortnight of data as though they were a
year's. Nothing errored and the numbers looked reassuring. `fixturePlan` is
a pure function, unit-tested in `scripts/test/`, and it rebuilds when the
year has moved on as well — the window ends yesterday, so a fixture built
last week no longer covers the range being asked about.

The script only runs `main` when it is the entry point. A test that imported
it to reach `fixturePlan` shelled out to wrangler and filled a database as a
side effect of reading a pure function.

Every night in it crosses midnight, deliberately: that is the case
`duration_sum` exists for, and a fixture of naps that all finished before
bedtime would never exercise the split. Adding them changed the expected row
count, which made the completeness check rebuild the database on its own —
the mechanism working rather than being trusted.

The integration tests do not use it. Their D1 is created for the run and
thrown away, so the year-scale test seeds its own rows directly into the
table; going through the API would mean thousands of POSTs and would hit the
500-a-day circuit breaker (spec 5.7), which is about runaway loops and not
about a year of history.

### The statistics screen

Every figure on it comes from `GET /stats`. **Nothing is aggregated in the
browser**, and the reason is not tidiness: a year is thousands of events, the
device holds only what it has synced, so a chart built locally would be short
by whatever has not arrived while looking complete — and would disagree with
the same chart on the other parent's phone (spec 5.6, 6.2).

Which means this screen needs a connection, and says so when it has none.
Failing to ask is not the same as nothing having happened, so a failure shows
a message rather than an empty chart: an empty chart is a claim.

Two things spec 7.7 asks for out loud, and both are easy to leave out because
the screen looks finished without them:

- **"Finished records only"**, on any type with a range. A timer still running
  has no length yet (spec 3.4.1 rule 3), so today is short for a reason
  nobody can see.
- **What is still on this phone.** The figures are the server's, so a queued
  record is missing from them. Saying so is the difference between a chart
  that is behind and one that is wrong.

A total is offered only where adding up means something — `count`, `sum`,
`duration_sum`. Summing weighings reports a toddler at twenty-one kilos.

The range arithmetic lives in `lib/stats-range.ts`, away from the screen,
because it is all off-by-one-day work.

**The four ranges are fixed day counts — 7, 30, 183, 365 — and not calendar
months**, and the buttons name the count rather than a month or a year. A
30-day range from 1 February runs to 2 March, and calling that a month is a
lie the screen has no way of admitting to — so the window's actual dates are
printed under the controls as well. Spec 7.7 carries the decision; AGENTS.md
is not the place for it to live alone.

**In a window anchored to its start**, calendar months cannot always end
today: "a month ending on 29 March" needs a start whose month-later date is 30
March, and there is none, because 28 February lands on 28 March and 1 March on
1 April. Subtracting a month and adding a day therefore produced a window
ending on 27 February when today was the 28th, leaving today off a chart of
the last month, and one ending on 31 March when today was the 29th — two days
that had not happened, zero-filled, dragging the daily average down.
Correcting the drift by hand did not converge either, because the clamp is not
a translation.

That is a limit of **this model**, not of calendar months, and an earlier
version of this note overstated it as an impossibility. Anchoring the window
to its end — today, with the start derived from it — works, and spec 7.7
records what moving to it would involve, including that it changes what the
date picker means.

Fixed counts also make the figures comparable: a total over a calendar month
changes between February and March partly because the months are different
lengths, which is not a fact about the baby. A test walks every day of three
years, leap Februaries included, and checks the default window ends exactly
today.

**The chart positions a value by its date, never by its place in the array.**
For the types that are not zero-filled — weight, temperature — the points are
irregular, and three weighings on the 1st, the 2nd and the 30th spaced evenly
draw a month of steady growth that did not happen. The axis labels come from
the days of the range for the same reason: taken from the points, a month with
no reading on its first loses its marker entirely. A line of one point has no
line in it, so readings are drawn as dots as well.

**The value axis is drawn, in the unit the type is read in** (spec 7.7).
It first was not: only the highest value sat in a corner, so a bar's height
meant nothing until compared with it by eye. Found on a phone.
`lib/chart-axis.ts` picks the ticks in the unit a parent reads -- whole
times for a count, degrees rather than the tenths a temperature is stored
in, minutes turning into hours past two of them -- and converts back to
stored numbers only to place them. The scale's top is the last tick, so a
bar reaching a gridline means that value.

**Where it starts is the owner's decision, recorded in spec 7.7.** Bars,
counts, totals and durations start at zero. A line of readings -- weight,
height, head size, temperature -- starts near its lowest one, because from
zero a fever is invisible, **and the screen says so in words** whenever it
does. The caption is the condition the decision was made on, and it has a
test of its own.

The temperature unit was `'C'` in the config while spec 3.1 says `'°C'`.
It is `'°C'` now, everywhere it is shown.

**A picked start survives a change of range.** Switching range used to
reset the start so the window ended today, so 7 days, 30, then 7 again lost
the day somebody had chosen. `startFor` keeps the pick and moves the window
back only as far as it must to end today, because days that have not
happened would be zero-filled into the average (spec 7.7); the pick is still
there for the next range it fits. Leaving the page still forgets it: it is
state, not in the address.

**The chart re-asks when the app catches up.** It watches `syncedAt` and the
local events, because the figures are the server's: without that the header
could say "just synced" with the unsynced notice gone while the chart was
still missing the record it was about. A failure gets its own retry, since
pressing sync only re-asks if the sync itself succeeds and the connection is
usually what failed first.

**The unsynced notice sits outside the chart.** "No records" plus a record
waiting on this phone is exactly when the reason matters most, and it was the
one case where it was hidden.

The chart is hand-drawn SVG. A charting library is a large thing to precache
for a phone that has to start with no connection at all (spec 6.2), and two
kinds of chart over at most 366 points is a few dozen lines of geometry.
Points the server left out are a gap the line joins across, which is exactly
what the no-zero-filling rule asks for.

### The M3 phone acceptance

The single-day timeline and the statistics page were taken through a phone by
the owner on 2026-09-25, over the LAN address -- neither needs HTTPS, since
nothing on either touches the service worker -- and **signed off**.

The steps are in `docs/running-locally.md`. Which of them were walked through
one by one was not reported back, so this is a sign-off and not a per-item
record: do not cite any single line of it as evidence that a particular case
was exercised. If a specific one matters later, ask before claiming it.

**Still outstanding, and not covered by that sign-off:**

- The 10 ms CPU measurement on `GET /stats`. It cannot be done locally at all
  (see below), needs a deployed Worker, and spec 12.1 lists it as an M3
  condition.
- Everything in spec 12.1 that needs a deployment: the login CPU measurement,
  a backup of the deployed database, the scheduled workflow.
- `avg` has no configured type, so that branch of the stats endpoint has no
  end-to-end test and nothing on a phone reached it either.

### What M3 can and cannot be shown to do locally

Checked here, and automated:

- **The aggregation is the database's, and its cost follows the aggregation
  families rather than the request.** Two types that aggregate the same way
  share one statement; a third family adds one; there are only three
  families, so the whole request is bounded however many types are asked
  about, and it does not move with the range at all. Pinned in
  `stats.test.ts`, not measured once and written down: asking for six types
  across three families costs the same as asking for three.
- **Spec 5.6's cap is per series, not per request.** A year of one type is at
  most 366 points; a year of four types is four series of up to 366 each, and
  the SQL behind it returns up to four rows per day. An earlier version of
  this note said "366 rows out of each query", which is only true of the
  single-type queries the fixture script happens to run.
- **The midnight split, the zero-filling rules, the units and the range
  arithmetic**, against a real D1 and across every day of three years for the
  window.
- **The chart ships without a charting library**: the precache is 10 entries
  and about 474 KiB, which is what the hand-drawn SVG is for (spec 6.2).

**Not checked here, and not checkable here:** the 10 ms CPU limit. Miniflare
does not enforce it (spec 11.2), so the SQL times `npm run db:stats-fixture`
prints are a laptop with no limit applied and say nothing about it. Spec 12.1
lists this as an M3 condition and it has not been carried out. Do not report a
local number as that acceptance.

Both pages have now been through a phone; see the sign-off above. The steps
need no tunnel, unlike the PWA ones: nothing on either page touches the
service worker, so the LAN address is enough.

### Which milestone owns the CPU measurement

Spec 5.6 said M4 and spec 12.1's acceptance table said M3. **M3 wins**, and
5.6 now says so with the reason: the endpoint is M3's work, so its acceptance
should not fall into the milestone after it. Both places also now state that
the measurement needs a deployment.


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

### A header title is centred by a spacer, never by a negative margin

Six screens centred their title with `-ml-11`, pulling it 44px left over the
back button beside it. The title comes later in the tree, so it lay on top
of the button and took most taps meant for it: in Chromium, a tap on the
button's right half or on its icon hit the title, and only its top-left
corner reached the link. On a phone that read as "back sometimes does
nothing". Found by the owner; confirmed by hit-testing both layouts in a
real browser, because jsdom does no layout and no test here can see it.

Every header now ends with a `size-11` spacer as wide as the back button,
which centres the title without anything overlapping. Stats and Tags already
did it that way.

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

**A "did not happen" assertion also has to be about a thing that screen can
show.** Waiting for `unsynced-count` to disappear from the add screen passes
on the first attempt for ever: that testid belongs to the home screen and was
never going to be there. Wait for something the screen in front of you
renders.

**A "did not happen" assertion needs something positive waited for first.**
`await waitFor(() => expect(queryBy(...)).not.toBeInTheDocument())` passes on
its first attempt, before the thing it is about has had a chance to render.
Three tests on the statistics screen passed that way — offering totals for
every aggregation and claiming "finished records only" for everything both
survived being broken. Wait for the new state to be on screen, then assert
the absence.

**Counting rows in the owner's database is reading the owner's database.**
Running `SELECT COUNT(*)` against `dongfan-dev` to show that nothing was
touched is self-contradictory, and it was done twice. There is nothing to
prove: not running anything against it is the whole of it. Say what was run
and against what, and leave that database out.

**A mutation that did not reach the running code proves nothing.** The API
suite resolves `@dongfan/shared` from `dist`, not from source, so breaking
something in `packages/shared/src` and re-running tests the old build and
comes back green. Rebuild shared, or the mutation is untested rather than
survived. The same goes for a patch that silently failed to apply: check the
file actually changed before believing the result. Both have happened here.

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
