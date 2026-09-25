# The calendar timeline: a redesign

Design only. Nothing here has been implemented. It covers the single-day
calendar (`/day/:date`, spec 7.5) and the two-day calendar (`/two/:date`,
spec 7.6), which are one design with one variable in it: the width of a band.

Read spec 7.5 and 7.6 first. This document does not restate the rules they
set; it decides how to draw them. Where it departs from what AGENTS.md
records, it says so and why.

**Language.** Copy is referred to by its key in
`packages/shared/src/i18n/zh-TW.ts`. This file is not one of the three paths
whitelisted for CJK (spec 13.1, 13.3), so it contains none: the sketches use
English stand-ins for type names, and the real screen renders
`eventTypeName(typeId)` from the i18n file as it does today. The owner's
comments are paraphrased rather than quoted for the same reason.

---

## 1. The problems

Each stated as what a parent sees, then why it is wrong.

### 1.1 Six and a half hours of the evening are one grey rectangle

The two-day view at a real 390x844 viewport, scrolled to the afternoon: the
left column reads "3 records", "5 records", "5 records" stacked down the
evening, and the right column is a single "6 records" running from 16:20 to
23:11. There is no icon, no colour, no time and no type anywhere in any of
them.

Why it is wrong. `layOut` groups items into a cluster by transitive overlap
of their *card boxes*, computes one column count for the whole cluster, and
sets `crowded` when that count exceeds `maxColumns`. When it is set, the
**entire cluster** collapses — a 6h51m stretch of the day becomes one
button. The crowding was real for about four minutes around 17:24;
everything from 17:52 to 23:11 was collapsed because of it.

This is the owner's point 3 exactly: a record in the eight o'clock hour has
no business being merged with one in the eleven o'clock hour. They are not
merged because they are close together. They are merged because something
*else* was close together, three hours earlier, and the collapse is decided
per cluster rather than per minute.

### 1.2 A chain of records nowhere near each other becomes one cluster

At `hourHeight: 64` and `minCardHeight: 44`, a card's minimum height covers
**41.25 minutes of axis**. Two records 40 minutes apart therefore collide as
cards while being nowhere near each other in time. In the current build this
is why the 12:19 nappy and the 12:56 bottle in screenshot 2 — 37 minutes
apart, with nothing between them — are drawn as two half-width cards.

Once they collide they are in one cluster, and a cluster is the unit that
collapses. The chain is the mechanism; 1.1 is the symptom.

### 1.3 The colour marks read as scattered debris

In the current single-day view the anchor lives in its own 9px lane and the
card begins 11px to its right. Scanning down a column you see a loose file of
dots and short bars with a visible gap between each mark and the card it
belongs to, and when there are two columns there are two such lanes at
different x. Nothing groups a mark with its card except proximity, and
proximity is what the layout has just spent its effort breaking.

That is the owner's point 1 — the colour bars look messy. It is not a taste
problem. The mark and the card are one record drawn as two objects.

### 1.4 The card carries almost no colour, and the colour it carries is unusable

A card is `bg-surface-raised` with a `border-line` border — the same for a
sleep, a nappy and a weighing. The type colour appears only in a 13px icon
and, when there is a value, in the number. Scanning a day for "when did he
sleep" means reading every card.

And the palette could not carry the load even if it were used: of 23
colours, five are near-identical teals (`bottle #5FC9B0`, `pumping #4FB89A`,
`doctor_visit #5BC8C0`, `illness #4FB9B2`, `medicine #6BD0BE`) and four are
near-identical purples. **Colour can identify a family, never a type.** Any
design that leans on colour alone to say which type is lying about what the
palette can do.

### 1.5 The collapsed entry says nothing

`zhTW.calendar.crowded` interpolates a count and that is the whole of it. A
parent looking at "6 records" cannot tell whether it is six nappies or a
feed, a bath and four moods, and cannot tell whether it covers four minutes
or seven hours. The owner's point 2.

### 1.6 A long range has no visual mass

In the previous two-day version a 5h47m nursing was a full-height bar whose
words were vertically centred, hours below the minute it started. That was
fixed by top-aligning. What was not fixed: a long range is still a card like
any other, and in the current build it is usually the thing that chains a
whole evening into one cluster and then disappears into it.

The two-day view exists to compare last night with tonight. If a night is
not a block whose shape you can see, the screen has no purpose.

---

## 2. The metrics

| Constant | Now | Proposed | Why |
|---|---|---|---|
| `hourHeight` | 64 | **96** | 2.1 |
| `minCardHeight` | 44 | 44 | Spec 7.5 floor; unchanged |
| *derived:* min card minutes | 41.25 | **27.5** | |
| `minCardWidth` | 128 | **48** | 2.2 |
| `LABEL_W` | — | **96** | 4.4 |
| `SPAN_KEEP` | — | **44** | 4.2 |
| `TIMELINE_GUTTER` | 44 | 44 | Unchanged |
| `GAP` | 4 | 4 | Unchanged |
| `ANCHOR_LANE`, `CARD_INSET` | 9, 11 | **removed** | 3.3 |

Band widths on a 390 CSS px phone: single day **346px**; two-day
`(346 − 6 divider) / 2` = **170px** each.

### 2.1 96 pixels per hour

41.25 minutes of spurious collision is the root of problem 1.2, and the
cheapest way to shrink it is to make an hour taller. At 96 it is 27.5
minutes.

What that buys, checkable against `packages/web/preview/fixtures.ts`:

- The 05:40 bottle and the 06:10 nappy on the later day (30 min apart) stop
  colliding. Both become full-width cards; at 64 they are two half-width
  cards.
- The 12:19 nappy and the 12:56 bottle in screenshot 2 (37 min apart) stop
  colliding.
- The 05:59 nappy and the 06:09 bottle (10 min apart) still collide, and
  should — they are ten minutes apart. No hour height fixes that short of
  264px/hour, and side by side is the right answer for them.

What it costs: the day is 2304px instead of 1536px. On a 390x844 phone the
scrollable axis area is roughly 680px, so a full day is 3.4 screens instead
of 2.3, and about 7.1 hours are on screen at once instead of 10.6. That is a
real cost and I am taking it: nobody reads 24 hours at once, and the thing
you do read — a night, an evening, a morning — is about four hours.

112 is the alternative if collisions still annoy on a phone (24.4 min, day
2688px). I would not go past that; below about 20 minutes the remaining
collisions are all genuine.

### 2.2 48 pixels is a readable card

`minCardWidth: 128` is why the current design collapses so eagerly: below
128px it gives up. 128 is the width needed to show icon, type name, value
and clock on one line, and that is the wrong thing to require.

**The badge is the type name.** 23 types, 23 distinct lucide glyphs. A
parent who uses this app twice a night learns them in a week, and the name
is redundant the moment the glyph is legible. Google's day view (screenshot
3) puts seven events side by side at about 90px each, showing two truncated
characters, and the owner offered that as the reference.

So a card degrades by dropping words, not by disappearing:

| Tier | Uncovered width | Shows |
|---|---|---|
| A | ≥ 160px | badge, name, value/duration, clock range, status |
| B | 96–159px | badge, name; clock + value/duration on line 2 |
| C | 64–95px | badge + value (or truncated name if no value); clock on line 2 |
| D | 48–63px | badge; clock on line 2 |

Below 48px a card is never drawn — the merge rule in section 4 prevents it.

The threshold is the card's **uncovered** width, not its column width. That
one word is what makes section 4.4 work.

---

## 3. The visual system

### 3.1 The colour decision: a tint, a knockout badge and a stripe

The owner offered two options (point 5): a left colour bar done properly, or
a coloured card background with the icon knocked out in the background
colour. **I am taking a third built from both, and rejecting the saturated
background.**

Rejected: a Google-style saturated fill (screenshot 3), for two reasons that
are not taste.

1. **Contrast cannot be made to work across 23 colours with one ink.**
   Google's model is dark text on a light block. This palette runs from
   `other #9A9086` through `weight #F08A8A` to `milestone #E8C55C`; their
   relative luminances are far enough apart that one dark ink either fails
   on the dark end or looks washed on the light end. Per-colour ink means a
   luminance computation in the renderer and 23 values to check by hand, and
   no CI check can see any of it.
2. **It is a torch at 3am.** `index.css` says in as many words that dark is
   not a preference here — the app is used in a dark room while holding a
   baby. A night's worth of solid `#74D39A` blocks undoes that.

Taken instead, and this is the whole of the colour system:

```css
/* --type is the event type's config colour, set per card as a CSS variable */

/* the card body */
background:   color-mix(in oklab, var(--type) 18%, var(--color-surface-raised));  /* range  */
background:   color-mix(in oklab, var(--type) 11%, var(--color-surface-raised));  /* moment */
border:       1px solid color-mix(in oklab, var(--type) 30%, var(--color-line));
border-top:   2px solid var(--type);          /* the start edge -- see 3.3 */
border-radius: 8px;

/* the numeric value, lifted toward the ink so every colour clears 7:1 */
color:        color-mix(in oklab, var(--type) 70%, var(--color-ink));
```

Ranges get 18% and moments 11%. That is not decoration: a range is a thing
you compare (how long was the night, how did tonight differ) and a moment is
a thing you count. Giving ranges more tint makes the day's shape — sleep and
wake — legible while scrolling past at speed, which is exactly what the
two-day view is for.

Measured against `--color-surface-raised: #241f19`, the worst case is
`other #9A9086` at 11%: body text in `--color-ink` clears 11:1 and the
lifted value colour clears 7:1. Every other colour is lighter and clears by
more.

**The knockout the owner asked for, at a size a dark theme can hold.** A
20x20 rounded square filled with the solid type colour, with the lucide
glyph drawn in `--color-ground`:

```
[#]   background: var(--type);  border-radius: 6px;  width/height: 20px
      icon:       EventIcon size=13 color=var(--color-ground) strokeWidth=2.2
```

This is the strongest type signal available and it costs 400 square pixels
per card instead of a whole card. It is the **last** thing dropped as a card
narrows, because it is the only thing that says which type. It should be a
new export beside `EventIconBadge` in `components/EventIcon.tsx` —
`EventIconChip` — taking the same `size` prop, so the home screen can adopt
it at 38px later if the owner likes it.

Risk to check on a phone: four glyphs are thin enough that knockout at 13px
may mush — `circle-dashed` (head_circ), `cloud-rain` (mood_crying),
`shower-head` (bath) and `circle-ellipsis` (other). If any fails, fall back
to `EventIconBadge`'s tinted circle for that card; do not shrink the whole
system for four icons.

**Palette recommendation, separately.** Five teals and four purples cannot
be told apart at 20px. Colours are display-only — unlike ids they are not
persisted, and changing one breaks nothing — so re-spacing the health and
mood families is safe and worth a stage of its own. This design does not
depend on it; it simply works better after.

### 3.2 The anatomy of a card

One element per record. No separate anchor, no separate lane. The card has
`overflow: visible`; truncation lives on an inner `min-w-0` wrapper, which
is what stops a rounded corner clipping a mark into a speck (problem 1.3,
and the first of AGENTS.md's four).

```
Tier A, full width

  o==========================================================+  <- 2px top edge in --type:
  # [#] sleep                              1 hr 7 min        |     the start minute, exactly
  # 09:46 - 10:53                                            |
  #                                                          |
  #        tinted body, height = the true 67 minutes         |
  #                                                          |
  '----------------------------------------------------------  <- 1px hairline, --type 45%:
  |                                                                the end minute
  '-- 3px stripe, solid --type, height = the true extent
```

Concrete values:

- padding `5px 6px 5px 9px` (the 9 is a 3px stripe plus a 6px gutter)
- badge 20x20, then a 4px gap
- name `12px / 600 / leading-tight` in `--color-ink`
- value and duration `12px / 600`, `font-numeric`, lifted type colour,
  right-aligned on line 1 at Tier A and B
- detail line `10px` in `--color-ink-faint`, one line, truncated
- the stripe: `left: 0; top: 0; width: 3px; height: <extent>px`, square
  corners, no radius, drawn as a child so no parent radius can clip it

**Tier B (96–159px)** — the two-day default:

```
  o====================+
  # [#] sleep          |
  # 9:46 . 1h07        |
  #                    |
```

**Tier C (64–95px)** — the value wins over the name, because the badge
already said the type and the number did not:

```
  o============+
    [#]  120ml |
    05:40      |
  '-------------
```

**Tier D (48–63px)** — badge and clock. The clock never drops: when a
timeline stops saying when, it has stopped being a timeline.

```
  o=======+
    [#]   |
    5:40  |
  '--------
```

**At the 44px minimum height** the anatomy is exactly two lines:
`5 (pad) + 20 (badge row) + 2 (gap) + 12 (detail) + 5 (pad) = 44`. That is
not a coincidence; it is what fixes the badge at 20px.

### 3.3 The anchor: the card's own edges

The separate anchor lane is removed. Instead:

- **The card's top edge is the start minute. Always, for everything.** Drawn
  as a 2px border in the solid type colour. There are no exceptions and no
  offsets, so the eye pairs card to minute by the only rule there is.
- **A moment** additionally carries a 7px dot at `left: 2px; top: -3.5px`,
  straddling that top edge in the solid type colour. It has no stripe,
  because it has no extent. Moment and range therefore have different
  silhouettes before you read a word.
- **A range** carries the 3px left stripe, whose height is the true extent
  in pixels. When the card is taller than the extent — anything under 27.5
  minutes at 96px/hour — the stripe is shorter than the card and says so.
- **A finished range** closes with a 1px hairline at the bottom, type colour
  at 45%. The bottom edge is the end minute.

**And the tint stops where the record stops.** A range whose card exceeds
its extent is painted with a hard-stop gradient:

```css
background: linear-gradient(to bottom,
  var(--tint) 0, var(--tint) var(--extent-px),
  var(--color-surface-raised) var(--extent-px));
```

When the extent is at least the card height this degenerates to a flat tint,
which is the common case, so it is one rule with no branch. When it does not
— a 13-minute nursing in a 44px card — the card is visibly a 21px band of
colour with a plain tail, and its height cannot be read as its duration.
That is the trap spec 7.5 names, answered by geometry rather than a caption.

Moments use a flat tint and no gradient. Their extent is zero, and a
gradient stopping at zero would paint nothing.

### 3.4 The states

Every state spec 7.5 and 7.2 require, and how it differs. `drafted` and
`queued` currently share dashed-plus-warn and are hard to tell apart; they
are separated here by a glyph, because a parent who confuses "stopped, not
confirmed" with "not sent" either stops a timer twice or leaves it running.

| State | Treatment | Detail line |
|---|---|---|
| synced, finished | as 3.2 and 3.3 | clock range, value, duration |
| running timer | no bottom hairline; bottom 10px fades to transparent; below the card a 2px **dashed** vertical line in `--type` at 45% runs to the now-line (today only) | `zhTW.event.inProgress` — never a duration |
| stop draft | dashed 1px border `--color-warn/70`; left stripe dashed over the draft's extent; `circle-check` 11px `--color-warn` top-right | `zhTW.calendar.draftEndedAt` |
| draft too long | as above, border and stripe solid `--color-warn`; glyph `triangle-alert` | `zhTW.calendar.draftTooLong` |
| queued (outbox) | dashed 1px border `--color-warn/55`; tint at 8%; opacity 0.92; `cloud-off` 11px `--color-warn` top-right; **top edge stays solid `--type`** so the time still reads as a real time | `zhTW.unsynced.badge` |
| carried over | **no top edge, no dot**; top 12px fades in from transparent | `zhTW.calendar.carriedOver` + `zhTW.calendar.onThisDay` |
| continues | **no bottom hairline**; bottom 12px fades out | `zhTW.calendar.continues` + `zhTW.calendar.onThisDay` |
| range with no end | moment treatment: dot, no stripe | `zhTW.calendar.noEnd` |
| all-day | band above the hours, row form, no geometry; 3px stripe full height | `zhTW.event.allDay` |

An open edge means "keeps going", in both directions. That is one idea
rather than two badges.

`zhTW.calendar.onThisDay` exists and is currently unused. A carried-over or
continuing range should use it: a 23:00–07:00 sleep shown on the morning is
seven hours of *this* day out of eight, and the card is the only place that
can say so.

The status glyphs named above — `cloud-off`, `circle-check` — are not in
`EventIcon.tsx`'s `ICONS` map and should not be added to it. That map's keys
come from the event type config; these are status marks and belong imported
directly in the timeline component.

---

## 4. The layout algorithm

Stated as numbered rules. Every one is a pure function of the items and the
band width, so all of it belongs in `lib/timeline.ts` and all of it is
unit-testable without a DOM.

### 4.0 Two kinds of item

```
extentMin = lengthMin                    // already clipped to the day
span      = extentMin > 0
pin       = extentMin === 0
```

A running timer is a **pin**. It has no end, its length is not a fact yet
(spec 3.4.1 rule 3), and treating it as a span would mean inventing one. A
back-filled range with no end time is a pin for the same reason. A stop
draft **is** a span, because `calendarDay` already asks `endOf` and the
draft's moment is this device's answer for the end.

This split is the owner's point 4 made structural: range events are not to
be merged. Spans and pins go down different paths and only pins can ever
merge.

### 4.1 Spans are laid out first, by true overlap, and are never merged

**Rule 1.** Two spans are concurrent iff their true intervals intersect:
`a.start < b.end && b.start < a.end`. Not their card boxes.

*Reasoning.* A pin's box is 27.5 minutes because of a fingertip; that is an
artefact of the card, not a fact about the record. A span's extent is a
fact. Letting an artefact narrow a fact is exactly how a 17:06 nappy pushed
a 5h47m nursing into a third of the band and then into a collapsed cluster.

**Rule 2.** Spans are grouped by transitive concurrency. Within a group,
columns are assigned greedily by start (longest first), and every span in
the group takes `1/n` of the band, where `n` is the group's column count. A
span with no concurrent neighbour takes the **whole band**.

*Reasoning.* This is Google's rule applied to the only items that have a
real extent, and it is what gives a night its mass. Uniform width across a
group means a span's width does not change part way down, which is the
predictability Google buys with the same trade.

**Rule 3.** Spans never merge into a collapsed entry, at any width. If more
spans are concurrent than the band can give 48px to — four at 170px — the
excess are drawn as **stripe only**: the 3px extent bar at the group's left,
no card, with a chip at the group's start listing them. Their extent is
still drawn and they are still reachable.

*Reasoning.* Five concurrent ranges for one baby is a data anomaly, not a
day. The rule exists so the behaviour is defined, not because it will fire.
Spec 3.5's unique `active = 1` index means at most four timer-started ranges
can be live at once, one per range type.

### 4.2 Pins are laid out in what is left

**Rule 4.** A pin's box is `[start, start + max(extent, 27.5min)]` — that
is, 27.5 minutes. Two pins collide iff their boxes intersect.

**Rule 5.** The pin area for a given pin is the band minus a left reserve:

```
reserve = 0                        if no span is live under the pin's box
        = SPAN_KEEP (44px)         if a span is live under the pin's box
        = LABEL_W + GAP (100px)    if the pin's box intersects the rows of
                                   any span's label zone (see 4.4)
```

Pins are assigned greedily by start into columns of the pin area, each at
least `minCardWidth` (48px) wide, and a pin expands rightwards into any
adjacent column free for the whole of its box.

*Reasoning.* When nothing is running, a lone nappy gets the whole 346px and
reads at Tier A. When a sleep is running underneath it, 44px of that sleep
stays visible — precisely enough for its stripe (the extent) and its badge
(the type), the two things that must never be covered. That is where the
number 44 comes from. It is not the tap-target 44 by coincidence, but it is
not the same 44 either.

**Rule 6.** A pin drawn over a span carries a 2px `--color-ground` ring, so
it reads as sitting on top rather than as a column beside.

### 4.3 What merges, and what bounds it

**Rule 7.** A pin that finds no column at 48px or more **overflows**.
Overflowed pins are grouped by their **clock hour**
(`floor(startMin / 60)`), and each hour with overflow gets one chip.

**Rule 8.** When an hour has overflow, every pin already placed in the
**rightmost pin column** whose start falls in that hour is evicted into the
same chip, and the chip takes that column for the hour.

**Rule 9.** A chip with one member is not drawn. The single pin is drawn as
a Tier D card at the band's right edge, above whatever is beneath it.

*Reasoning for 7 to 9 — the owner's point 3, answered literally.* A merge is
bounded three ways and all three are checkable:

1. **By the clock hour.** Two records can only merge if they start in the
   same clock hour. A record in the eight o'clock hour can never be in a
   chip with one from the eleven o'clock hour, whatever else is on screen.
   This is the owner's proposal and it is better than any bound I can
   derive, because the boundary is a thing a parent can see on the axis
   rather than a number in the code.
2. **By kind.** Only pins merge. A range always keeps its own block.
3. **By necessity.** A chip appears only when the width genuinely runs out,
   never because a cluster somewhere contained a crowded minute.

The consequence, stated rather than discovered later: two pins at 17:58 and
18:02 are four minutes apart and in different hours, so they will never
merge. They compete for columns and, if there is no room, each becomes a
Tier D card at the right edge under rule 9. That is the price of a bound a
parent can see, and it is worth paying.

**What is deleted.** `Cluster`, `crowded`, `MAX_COLUMNS`, `columnsFor` and
the cluster-wide collapse all go. The output becomes:

```ts
type DayLayout = {
  allDay: readonly TimelineItem[];
  spans:  readonly PlacedSpan[];   // item, top, height, left, width, labelWidth
  pins:   readonly PlacedPin[];    // item, top, left, width, overSpan
  chips:  readonly HourChip[];     // hour, members, top, height, left, width
  firstMin: number | null;         // for openingMinute
};
```

`openingMinute` reads `firstMin` instead of `clusters[0].fromMin`. Nothing
else about scrolling changes — spec 7.5 is explicit that a background sync
or the clock ticking must not take the position back, and none of this
touches that.

### 4.4 The label zone: why a span's words are never covered

**Rule 10.** Every span reserves a **96x44 label zone** at its top-left
(`LABEL_W = 96`, the height being `minCardHeight`), clamped to the span's
own column width. Pins may not enter it.

**Rule 11.** A span's card is one element at its full column width. Its text
block is a child rendered at the span's **uncovered width** — the width of
the widest strip, measured from the card's left edge, that no pin or chip
covers across the label zone's rows. The tier in 2.2 is chosen from that
number.

*Reasoning.* Without rule 10 this is circular: the tier depends on the
coverage, the coverage depends on how wide the pins are, and the pins are
laid out relative to the tier. Reserving a fixed 96px breaks the circle and
guarantees **every span reaches Tier B** — badge, name, clock and duration.
That is the floor a comparison screen needs. At 170px, 96 is 56% of the
band, and that proportion is deliberate: on the two-day screen a span's
words are the thing being compared.

Rule 11 is also what lets one element be both the block and the label. The
block is the full column width, tinted, with its stripe and edges; the words
sit in a narrower child. There is no second element and therefore no second
thing to get out of sync.

### 4.5 The order of operations

```
1. splitAllDay(items)                                    -> allDay band
2. partition the rest into spans and pins
3. spans -> concurrency groups -> columns -> left/width      (rules 1-3)
4. compute each span's label zone                            (rule 10)
5. pins  -> reserve -> columns in the pin area -> expand     (rules 4-6)
6. pins with no column -> hour chips; evict same-hour pins   (rules 7-9)
7. for each span, measure uncovered width -> tier            (rule 11)
8. for each pin and chip, its own width -> tier              (2.2)
```

Every step is a pure function of `(items, bandWidth, metrics)`. At most
about forty items a day and at most seven columns, so the naive
rectangle-intersection tests in steps 5 and 7 are free; there is no reason
to be clever. The greedy `ends[]` shortcut in today's `assignColumns` must
be replaced by a real per-column interval list, because placing spans before
pins means items no longer arrive in start order and a single "last bottom"
per column is then wrong.

### 4.6 Tests that would have caught the screenshot

In this repository's terms — break the thing and watch it fail:

- The evening of `LATER_DAY` at `bandWidth: 346` produces **six** placed
  items and **zero** chips. Remove rule 1 (collide spans on boxes) and it
  collapses again.
- No chip's members span more than one clock hour. Remove rule 7's hour
  grouping and a chain reproduces the "6 records" block.
- No chip contains an item with `extentMin > 0`. Remove rule 3 and a nursing
  lands in a chip.
- Every span's `labelWidth >= 96`. Remove rule 10 and the 16:44 walk drops
  to Tier D.
- A 13-minute nursing has `cardHeight 44` and `stripeHeight 21`. Both
  numbers, both asserted; `timeline.test.ts` already pins this pair and
  should keep doing so.
- The 05:40 bottle and the 06:10 nappy are both full width at
  `hourHeight: 96` and both half width at 64. That one is the regression
  test for the metric itself.

---

## 5. The collapsed entry

The chip is the answer to the owner's point 2. It must say what is inside it
without being opened.

**Geometry.** Top = the first member's start minute, a real minute on the
axis. Height = `44 + minutesToPx(last.start - first.start)`, clamped to the
remainder of its clock hour. A chip covering 17:06–17:24 is therefore 73px
and reads as a stretch rather than as a record.

**Contents**, top to bottom:

```
  .-------------------.
  # [#][#][#] +2      |   row 1: up to 4 knockout badges at 16px, start order
  # 5 records         |   row 2: interpolate(zhTW.calendar.crowded, {count})
  # 17:06 - 17:41     |   row 3: formatClock(first) - formatClock(last)
  '-------------------'
  '-- 3px stripe, segmented: one equal segment per member, in start order,
      each in that member's type colour
```

- **Row 1** is the answer to "what is in there". Distinct types in start
  order; a repeated type shows one badge with a 9px numeral knocked out at
  its bottom-right. More than four distinct types: three badges and `+N` in
  10px `--color-ink-muted`.
- **Row 3** needs 64px of width; below that it truncates to the first clock.
  It is dropped last, after the count, because *when* outranks *how many*.
- **The stripe is a miniature of the contents in time order.** It costs
  nothing, and it means even a 48px chip carries the colour families inside
  it.

**A container, not a record.** `--color-surface` with a 1px `--color-line`
border and an 8px radius — deliberately unlike a card, so nobody reads a
chip as an event.

**Reachability.** `aria-label` lists every member as
`eventTypeName(typeId)` plus `formatClock(start)`, so nothing is hidden from
a screen reader either. Tapping expands to the existing overlay list, which
keeps its present form — rows with no time geometry, because a row stands
for a record and not for a stretch — headed by the chip's hour and range.

**The open key changes** from `${day}@${cluster.fromMin}` to
`${day}@h${hour}`, for example `2026-09-25@h17`. The day stays in it, for
the reason AGENTS.md records: both columns have a 09:00. The hour replaces
the minute because a minute moves when a record is added nearby, which
silently closes a list somebody had open; an hour does not. It is also the
same key in both views, so a list opened on the two-day screen is still open
after tapping through to the single day.

---

## 6. The two-day adaptation

The band is 170px instead of 346px. That is the only input that changes.

**What must not change, because the screen's purpose is comparison:**

- `hourHeight`, and therefore every vertical position and every extent. One
  axis of hour labels, two bands over it. Already true; it is the point.
- `minCardHeight`, the tint percentages, the tier table, the badge, the
  stripe and the states.
- **The merge rules.** The hour bound and the pins-only bound are rules
  about time and kind, not about width. What changes with width is only
  *whether* a merge is needed.
- `LABEL_W` stays **96px**, 56% of the band. A span that cannot show its
  name and its duration is useless for comparing two nights.

**What changes:**

- Pin columns: at 170px with one span live the pin area is 70–126px, so one
  column, occasionally two. At 346px it is four or five.
- Cards sit a tier or two lower. The two-day default is Tier B; a pin over a
  span with a label zone in the way is Tier C.
- **Merging happens sooner.** The same hour that shows three separate cards
  on the single-day screen may be a two-record chip on the two-day screen.

That last one is a real asymmetry and it is correct: capacity is a function
of width, and pretending otherwise would mean either collapsing the wide
screen needlessly or overflowing the narrow one. It should be said out loud
in review rather than found later. The shared `?open=` key means tapping
through from a chip to the single-day view shows the same stretch expanded,
which is the natural way out of it.

**One addition the two-day view needs and does not have:** a 1px
`--color-line-soft` divider running the full height between the bands. In
the current build the two columns float in the same space, and a card at the
right edge of the left band abuts a card at the left edge of the right one
with nothing between them.

---

## 7. Worked examples

Scale for all sketches: **one text row = 15 minutes**, four rows to the
hour. The single-day band is **58 columns, about 346px**; each two-day band
is **28 columns, about 170px** — the true proportion. A minute label on a
row means the record starts at that minute, drawn on the nearest row.

```
  =  2px start edge      o  a moment's dot       #  3px extent stripe
  -  1px end hairline    :  dashed (draft)       [#] knockout badge
```

Type names are English stand-ins; the screen renders `eventTypeName`. All
records are from `packages/web/preview/fixtures.ts`.

### (a) A quiet morning — single day, 2026-09-25, 04:00–07:00

The night carried over from the 24th ends at 05:30. A bottle at 05:40, a
nappy at 06:10.

```
        |<--------------------- band: 346px --------------------->|
 04:00 -+---------------------------------------------------------
        |#
        |#   sleep, carried over from 20:34 -- no top edge, and its
 04:30 -+#   label was drawn at 00:00, at the top of the day
        |#
 05:00 -+#---------------------------------------------------------
        |#
 05:30  |'---------------------------------------------------------   end hairline
        |
 05:40  o=========================================================+   05:40 exactly
        |  [#] bottle                                       120ml |
 06:00 -+  05:40 --------------------------------------------------
        |  '-------------------------------------------------------   44px card, ends 06:07
 06:10  o=========================================================+
        |  [#] nappy                                              |
 06:30 -+  06:10 --------------------------------------------------
        |  '-------------------------------------------------------
 07:00 -+---------------------------------------------------------
```

Both pins are full width and Tier A: 30 minutes apart is more than 27.5, so
they do not collide. At `hourHeight: 64` they would be two half-width cards.
The night has no top edge, and its card is a tall tinted block whose stripe
runs its whole height.

### (b) A busy evening — single day, 2026-09-25, 16:00–23:30

Six records: solid 16:27, walk 16:44–17:10, nappy 17:06, nursing
17:24–23:11, nappy 17:24, and a sleep timer started 21:00 and stopped on
this device at 22:30 without being confirmed. This is the stretch that
currently renders as a single "6 records" button.

Walk and nursing are not concurrent, so both take span column 0. Nursing and
the sleep draft are concurrent, so that group is two columns of 171px. The
three pins sit in the pin area right of the 96px label zone, which starts at
column 17.

```
        |<-------------------- band: 346px --------------------->|
 16:00 -+--------------------------------------------------------
        |                x=100
 16:27  |                o=======================================+   246px, Tier A
        |                |  [#] solid food                       |
 16:44  o================|  16:27                                |   walk starts: full band,
        |# [#] walk      |  '--------------------------------------   label clipped to 96px
 17:00 -+# 26 min -------+-------------------+---------------------
 17:06  |#               o=================+ |                        two pin columns,
 17:10  |'---------------|  [#] nappy      | |                        121px each, Tier B
        |                |  17:06          | |
 17:24  o================|  '---------------  o====================+
        |# [#] nursing   |                    |  [#] nappy        |
 17:30 -+# 5 hr 47 min --+--------------------|  17:24 ------------
        |#  (171px: it shares with the        '---------------------
        |#   21:00 draft below)
 18:00 -+#-------------------------------------------------------
        |#
        |#      six and a half hours of tinted block, 18% of
 19:00 -+#      #74D39A, with the stripe running its full height
        |#
 20:00 -+#-------------------------------------------------------
        |#
 21:00 -+#---------------:=======================================+
        |#               : [#] sleep          stop draft, 22:30  :    dashed border,
        |#               : 21:00 . 1 hr 30 min                   :    dashed stripe,
 22:00 -+#---------------:---------------------------------------:    circle-check glyph
        |#               :                                       :
 22:30  |#               :'---------------------------------------
        |#
 23:00 -+#-------------------------------------------------------
 23:11  |'---------------------------------------------------------   nursing ends
 23:30 -+---------------------------------------------------------
```

Six cards, all readable, nothing collapsed, and the 5h47m nursing is a block
whose shape you can see. Compare with the current build, where all of this
is one grey rectangle with a count in the middle of it.

### (c) Four records within six minutes — single day, 2026-09-25, 08:00

Bottle 08:00 (90ml), nappy 08:02, bottle 08:04 (110ml), nursing 08:06–08:19.

Nursing is a span and takes the full band. Its label zone is 96px wide, so
the three pins are laid out in `[100, 346]` — 246px, three columns of 79px.

```
        |<-------------------- band: 346px --------------------->|
 08:00 -+---------------o============+============+=============+-
        |               | [#]   90ml |            |             |
 08:02  |               | 08:00      o============+             |     each card's top
        |               |            | [#]        |             |     edge is its own
 08:06  o===============|            | 08:02      o=============+     minute
        |# [#] nursing  |            |            | [#]   110ml |
 08:15 -+# 13 min ------+------------+------------+  08:04 ------
 08:19  |'--------------'------------'------------'---------------
        |
        |   nursing ends at 08:19; its stripe stops at 21px while
 08:30 -+   its card runs the full 44px, and the tint stops with
        |   the stripe
```

Four records inside six minutes, all four visible, nothing merged. Three
79px pins are Tier C — badge and value, clock on line 2 — which is enough to
answer "which feed was which". The nursing keeps a real block whose stripe
is 21px inside a 44px card.

This is the case the owner's point 3 *allows* to merge — one clock hour, all
points — and at 346px it does not need to.

### (d) The same evening in the two-day view

2026-09-24 on the left, 2026-09-25 on the right, one axis, 170px each. Shown
at true proportion: 28 columns per band against the 58 above.

```
           |<---- 170px ------------>|<---- 170px ------------>|
           |      2026-09-24         |      2026-09-25         |
 16:00 ----+-------------------------+-------------------------
           |                         |
 16:07     o========================+|                x=100
           |# [#] pumping     170ml ||                |
 16:24     |'------------------------| 16:27          o=======+   70px, Tier C
 16:35     o========================+|                | [#]   |
           |# [#] walk              || 16:44 o========| solid |
           |# 30 min                ||       |# [#]   | 16:27 |
 16:42     |     o=================+||       |# walk  '--------
 17:00 ----+-----|  [#] nappy      ||+-------|# 26min---------
 17:05     |'----|  16:42          |||       |'--------
           |     '-----------------'|| 17:06          .-------.
           |                         |                | [#][#]|   chip, 70px
           |                         |                | 2 recs|
 17:24     |                         | 17:24 o========| 17:06 |
           |                         |       |# [#]   | 17:24 |
 17:42     o========================+|       |# nurs  '--------
           |# [#] solid food        ||       |# 5h47m
 18:00 ----+#------------------------+-------|#----------------
 18:19     o========================+|       |#
           |# [#] mood: sad         ||       |#
 18:27     |  o=====================+|       |#
           |  |  [#] nappy          ||       |#
 19:00 ----+--'----------------------+-------|#----------------
 19:03     o========================+|       |#
           |# [#] bath   17 min     ||       |#
 19:20     |'------------------------|       |#
 19:35     o========================+|       |#
           |  [#] bottle      223ml ||       |#
 20:00 ----+-------------------------+-------|#----------------
 20:21     o========================+|       |#
           |  [#] temp       36.5 C ||       |#
 20:34     o========================+|       |#
           |# [#] sleep             ||       |#
 21:00 ----+# 8 hr 56 min -----------+-------|#---:===========+
           |# continues to next day ||       |#   : [#] sleep |
           |#                       ||       |#   : 21:00     |    stop draft,
 22:00 ----+#-----------------------(|-------|#---: 1 hr 30m  |    dashed
 22:30     |#   no bottom hairline:  ||       |#   :'-----------
 22:50     |#  .------------------. ||       |#
           |#  | [#][#]  2 recs   | ||       |#
 23:11     |#  | 22:50 - 22:58    | ||       |'--------
 23:30 ----+#--'------------------'-++-------------------------
```

Two nights on one scale, which is what the screen is for. The left column's
sleep block runs from 20:34 off the bottom of the day with no closing
hairline; the right column's is a dashed 90-minute draft. You can see the
difference without reading a word.

Note how narrowly bounded the two chips are — 17:06–17:24 on the right,
22:50–22:58 on the left. Neither reaches beyond its own hour, and neither
contains a range: on the left the 22:50–22:58 nursing keeps its own block
under rule 3, and only the 22:50 nappy and the 22:58 bottle merge.

---

## 8. What this costs

**Traded away, knowingly.**

- **A third more scrolling.** 2304px per day instead of 1536. About 7.1
  hours on screen instead of 10.6. Scanning a whole day for a single record
  is slower; reading a night is better. I think that is the right way round
  for this app, but it is a real loss and it is the first thing to revisit
  if the owner dislikes it — one constant, no other change.
- **The two views can disagree about which hours are collapsed.** Correct,
  since capacity follows width, but surprising. Mitigated by the shared
  `?open=` key; not eliminated.
- **A span's label tier can change when a record is added near its top.**
  Bounded by the 96px reservation — it can never drop below Tier B — but the
  same record can look slightly different after a sync. The alternative is
  reserving the full width, which wastes it.
- **The free-standing anchor is gone**, and with it the guarantee that an
  extent is visible even when the card is covered. The stripe now lives at
  the card's own x=0..3, so a pin covering the card would hide it. That is
  what `SPAN_KEEP = 44` exists to prevent, and it is the only thing
  preventing it.
- **`minCardWidth: 48` means cards showing a badge, a clock and nothing
  else.** Someone who has not learned the 23 glyphs will find Tier D
  unreadable. It only appears in genuinely crowded minutes, but it is the
  weakest point of the design and it depends entirely on the badge being
  legible at 20px.

**What gets worse for specific records.**

- A long range that happens to be concurrent with a short one is half width
  for its entire length (rule 2, Google's trade). A 15-minute walk at 21:00
  halves an eight-hour night. Predictability was chosen over width; a
  per-slice width would be more efficient and much harder to reason about.
- Two pins either side of an hour boundary never merge (rule 9) and can each
  end up as a 48px card at the right edge. Ugly, rare, and the price of a
  bound a parent can see on the axis.

**What I am not sure about, and what would settle it.**

- **96 versus 112 px/hour.** I have arithmetic, not a phone. The number to
  watch is how often two records that feel unrelated still end up side by
  side. Five minutes with the preview harness on a real device settles it.
- **The hard-stop gradient.** I believe a 21px band of colour inside a 44px
  card reads as "this is how long it was". It might read as a rendering bug.
  It is one CSS line to try both ways.
- **The knockout badge at 13px** for `circle-dashed`, `cloud-rain`,
  `shower-head` and `circle-ellipsis`. Fall back per icon if needed.
- **The dashed line from a running timer down to the now-line.** It is not a
  duration claim — the card says `zhTW.event.inProgress` and never a number,
  and spec 7.2 already allows the home screen's live timer display as a UI
  computation unrelated to statistics. But it is the one element here that
  could be *read* as an extent for a record that has none (spec 3.4.1 rule
  3), so it should ship dashed, ship reversible, and be the first thing
  questioned in review.
- **Whether the home screen's `EventIconBadge` should become the knockout
  chip too.** Spec 7.5 asks the calendar to be consistent with the home
  screen in colour, icon and status wording, so two badge shapes is arguably
  drift. I have left the home screen alone because 38px of tinted circle
  reads well and nothing is broken, but it is a judgement call and the owner
  should make it rather than have it made by omission.

**Deliberately not in this design.** No drag to move a record, no stretch to
change a duration, no tap-empty-space to add — spec 7.5 rules all three out
for this round. No charting or layout library. No change to `calendarDay`,
to which day a record belongs, to the widened lower bound, or to any
duration statistic: the redesign is entirely downstream of `itemsFor`.
