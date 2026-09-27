import { describe, expect, it } from 'vitest';
import { MAX_EVENT_DURATION_MS, localToUtc, startOfLocalDay } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import type { DayEntry, QueuedCreate, StopDraft } from '../src/lib/db.js';
import {
  CHIP_HEIGHT, DEFAULT_METRICS, MINUTES_IN_DAY, MIN_EXTENT_PX, SPAN_KEEP, boxOf, extentOf,
  itemsFor,
  labelWidthFor, layOut, minCardMinutes, minutesToPx, openingMinute, splitAllDay, textWidth,
  tierFor,
} from '../src/lib/timeline.js';

/**
 * Where a day's records land on a fixed 00:00-24:00 axis (spec 7.5).
 *
 * A timeline is a picture of numbers, and a picture cannot be argued with.
 * An event drawn an hour out, a nap drawn as tall as a night because its card
 * has a minimum height, a night attributed wholly to the evening it started
 * in -- all of them look exactly as convincing as the correct drawing, and
 * none of them throws.
 *
 * Every fixture here is invented. Nothing reads a database.
 */

const TZ = 'Asia/Taipei';
const DAY = '2026-06-15';
const NEXT = '2026-06-16';

const at = (date: string, hour: number, minute = 0): number =>
  localToUtc({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)), hour, minute }, TZ);

function event(over: Partial<EventDto> & { id: string; typeId: string }): EventDto {
  return {
    babyId: 'baby-1',
    createdBy: 'user-1',
    createdAt: 0,
    updatedAt: 0,
    startedAt: at(DAY, 9),
    endedAt: null,
    localDate: DAY,
    value: 1,
    note: '',
    metadata: {},
    version: 1,
    rev: 1,
    active: false,
    deletedAt: null,
    tagIds: [],
    ...over,
  };
}

function entry(e: EventDto, carriedOver = false): DayEntry {
  return { event: e, carriedOver };
}

function queued(over: Partial<QueuedCreate['input']> & { typeId: string }, id = 'q1'): QueuedCreate {
  return {
    scope: 's',
    userId: 'user-1',
    babyId: 'baby-1',
    eventId: id,
    input: {
      intent: 'record',
      startedAt: at(DAY, 9),
      endedAt: null,
      note: '',
      metadata: {},
      ...over,
    },
    state: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    outcomeUnknown: false,
    lastCode: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as QueuedCreate;
}

const draft = (eventId: string, endedAt: number): StopDraft =>
  ({ scope: 's', eventId, endedAt, version: 1, createdAt: 0 });

const items = (
  entries: DayEntry[],
  q: QueuedCreate[] = [],
  d: StopDraft[] = [],
  date = DAY,
) => itemsFor(entries, q, d, date, TZ);

describe('where a record sits', () => {
  it('positions by the clock and sizes by the duration', () => {
    // Spec 7.5's own example: an hour of sleep occupies an hour, and a
    // bottle half an hour in sits in the middle of it.
    const [sleep, bottle] = items([
      entry(event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 10) })),
      entry(event({ id: 'bottle', typeId: 'bottle', startedAt: at(DAY, 9, 30) })),
    ]);

    expect(sleep).toMatchObject({ startMin: 9 * 60, lengthMin: 60 });
    expect(bottle).toMatchObject({ startMin: 9 * 60 + 30, lengthMin: 0 });
  });

  it('gives a moment no length rather than a small one', () => {
    // Zero is not "instant". It is "this has no length to draw", and the
    // difference matters because the card is taller than zero either way.
    const [bottle] = items([entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 14, 7) }))]);
    expect(bottle?.lengthMin).toBe(0);
    expect(bottle?.startMin).toBe(14 * 60 + 7);
  });

  it('gives a back-filled record with no end time no length either', () => {
    // Not a running timer -- a record somebody has not finished filling in
    // (spec 3.5). Inventing a duration for it would be inventing data.
    const [only] = items([
      entry(event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 13), endedAt: null, active: false })),
    ]);
    expect(only).toMatchObject({ lengthMin: 0, running: false });
  });

  it('marks a timer that is still running, and gives it no length', () => {
    const [only] = items([
      entry(event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 13), active: true })),
    ]);
    expect(only).toMatchObject({ lengthMin: 0, running: true });
  });
});

describe('a night that crosses midnight', () => {
  const overnight = event({
    id: 'night',
    typeId: 'sleep',
    startedAt: at(DAY, 23),
    endedAt: at(NEXT, 7),
    localDate: DAY,
  });

  it('draws the evening end on the evening', () => {
    const [night] = items([entry(overnight)]);
    expect(night).toMatchObject({ startMin: 23 * 60, lengthMin: 60, continues: true, carriedOver: false });
  });

  it('draws the morning end on the morning, starting at midnight', () => {
    const [night] = items([entry(overnight, true)], [], [], NEXT);
    expect(night).toMatchObject({ startMin: 0, lengthMin: 7 * 60, carriedOver: true, continues: false });
  });

  it('is the same event from either day, so either opens the same screen', () => {
    const evening = items([entry(overnight)])[0];
    const morning = items([entry(overnight, true)], [], [], NEXT)[0];
    expect(evening?.eventId).toBe('night');
    expect(morning?.eventId).toBe('night');
  });

  it('makes no zero-length piece on the next day when it ends at midnight', () => {
    // The closed-interval rule for day queries does not mean the midnight
    // end is drawn on both days (spec 7.5).
    const toMidnight = event({
      id: 'n2', typeId: 'sleep', startedAt: at(DAY, 23), endedAt: at(NEXT, 0), localDate: DAY,
    });
    expect(items([entry(toMidnight)])[0]).toMatchObject({ startMin: 23 * 60, lengthMin: 60 });
    // `calendarDay` does not return it for the next day at all, which is
    // what stops the empty piece; nothing here invents one either.
    expect(items([], [], [], NEXT)).toEqual([]);
  });

  it('never runs past the end of the day it is drawn on', () => {
    const [night] = items([entry(overnight)]);
    expect((night?.startMin ?? 0) + (night?.lengthMin ?? 0)).toBeLessThanOrEqual(MINUTES_IN_DAY);
  });
});

describe('all-day events', () => {
  it('head the day instead of sitting at midnight', () => {
    // Stored at local midnight (spec 3.9), so on an hour axis they would sit
    // under the night feeds rather than above the day.
    const { allDay, timed } = splitAllDay(items([
      entry(event({ id: 'm', typeId: 'milestone', startedAt: at(DAY, 0) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 9) })),
    ]));

    expect(allDay.map((one) => one.eventId)).toEqual(['m']);
    expect(timed.map((one) => one.eventId)).toEqual(['b']);
  });

  it('are kept out of the hour layout entirely', () => {
    const layout = layOut(items([
      entry(event({ id: 'm', typeId: 'milestone', startedAt: at(DAY, 0) })),
    ]));
    expect(layout.allDay).toHaveLength(1);
    expect(layout.spans).toEqual([]);
    expect(layout.pins).toEqual([]);
  });
});

describe('ranges and moments are two different problems', () => {
  // A phone, less the hour labels; and half of it, which is a two-day
  // column. Every layout question below has a different answer at each.
  const WIDE = 346;
  const HALF = 173;
  const lay = (entries: DayEntry[], band = WIDE) =>
    layOut(items(entries), DEFAULT_METRICS, band);

  it('decides that two ranges overlap by their times, never by their cards', () => {
    // Both are long enough that their cards *are* their extents, so their
    // times are the whole question: a 09:00 nap ending at 09:40 and a walk
    // from 09:45 do not overlap, and neither do their cards.
    const layout = lay([
      entry(event({ id: 'a', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 40) })),
      entry(event({ id: 'b', typeId: 'walk', startedAt: at(DAY, 9, 45), endedAt: at(DAY, 10, 30) })),
    ]);

    // Both take the whole band, one after the other.
    expect(layout.spans.map((one) => one.width)).toEqual([1, 1]);
    expect(layout.spans.map((one) => one.left)).toEqual([0, 0]);
  });

  it('does not let two short ranges sit on top of one another', () => {
    // Both are shorter than the 27.5 minutes a card's minimum height
    // covers, so both get a card bigger than they are -- and ten minutes
    // apart those two cards overlap by 28px. Their times do not intersect,
    // and laying them out by their times alone drew the second over the
    // first: its words, its colour and its tap target all covered.
    //
    // A card that is bigger than its record is the same kind of thing as a
    // moment's card, so it is laid out among them.
    const layout = lay([
      entry(event({ id: 'n', typeId: 'nursing', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 5) })),
      entry(event({ id: 'w', typeId: 'walk', startedAt: at(DAY, 9, 10), endedAt: at(DAY, 9, 15) })),
    ]);

    expect(minCardMinutes(DEFAULT_METRICS)).toBeGreaterThan(10);
    expect(layout.spans).toEqual([]);
    expect(layout.chips).toEqual([]);
    expect(layout.pins).toHaveLength(2);
    // Side by side, and nowhere near each other's space.
    const [a, b] = layout.pins;
    expect(a!.left + a!.width).toBeLessThanOrEqual(b!.left + 0.0001);
  });

  it('keeps a short range out of the span columns, so it narrows nothing', () => {
    // Five minutes at 09:00 and three hours from 09:20. They do not
    // overlap, and the five minutes must not halve the three hours for its
    // whole length -- which is what colliding ranges on their card boxes
    // would do, and is the failure this redesign began with.
    const layout = lay([
      entry(event({ id: 'n', typeId: 'nursing', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 5) })),
      entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 9, 20), endedAt: at(DAY, 12, 20) })),
    ]);

    expect(layout.spans.map((one) => one.item.eventId)).toEqual(['s']);
    expect(layout.spans[0]?.width).toBe(1);
    // And the short one still draws its own five minutes.
    expect(layout.pins[0]?.item.lengthMin).toBe(5);
  });

  it('shares the band between ranges whose times really do intersect', () => {
    const layout = lay([
      entry(event({ id: 'a', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 11) })),
      entry(event({ id: 'b', typeId: 'walk', startedAt: at(DAY, 10), endedAt: at(DAY, 12) })),
    ]);

    expect(layout.spans.map((one) => one.width)).toEqual([0.5, 0.5]);
    expect(layout.spans.map((one) => one.left)).toEqual([0, 0.5]);
  });

  it('gives the longer of two concurrent ranges the first column', () => {
    // So the night is on the left and the fifteen minutes that overlap it
    // are beside it, rather than the other way round.
    const layout = lay([
      entry(event({ id: 'walk', typeId: 'walk', startedAt: at(DAY, 21), endedAt: at(DAY, 21, 15) })),
      entry(event({ id: 'night', typeId: 'sleep', startedAt: at(DAY, 21), endedAt: at(DAY, 23) })),
    ]);

    const night = layout.spans.find((one) => one.item.eventId === 'night');
    expect(night?.left).toBe(0);
  });

  it('never puts a range behind a collapsed entry, at any width', () => {
    // The owner's rule, made structural: only moments can ever merge. Five
    // records in six minutes on a half-width column, one of them a range.
    const layout = lay([
      entry(event({ id: 'n', typeId: 'nursing', startedAt: at(DAY, 8), endedAt: at(DAY, 8, 13) })),
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 8, 1) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 8, 2) })),
      entry(event({ id: 'c', typeId: 'bottle', startedAt: at(DAY, 8, 3) })),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 8, 4) })),
    ], HALF);

    // It may be laid out among the moments -- its card is bigger than it
    // is -- but it may never be folded into an entry.
    expect(layout.chips.length).toBeGreaterThan(0);
    for (const chip of layout.chips) {
      expect(chip.members.every((one) => one.lengthMin === 0)).toBe(true);
    }
    expect([...layout.spans, ...layout.pins].some((one) => one.item.eventId === 'n')).toBe(true);
  });

  it('keeps a lone moment the whole width of the band', () => {
    const layout = lay([entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 9) }))]);
    expect(layout.pins[0]).toMatchObject({ left: 0, width: 1 });
  });

  it('puts two moments that collide side by side, and no more than that', () => {
    const layout = lay([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 9) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 9, 4) })),
    ]);

    expect(layout.chips).toEqual([]);
    expect(layout.pins.map((one) => one.width)).toEqual([0.5, 0.5]);
  });
});

describe('what a moment may cover of a range, and what it may not', () => {
  const WIDE = 346;
  const lay = (entries: DayEntry[], band = WIDE) =>
    layOut(items(entries), DEFAULT_METRICS, band);

  const night = () => event({
    id: 'night', typeId: 'sleep', startedAt: at(DAY, 20), endedAt: at(DAY, 23),
  });

  it('leaves a range its stripe and its badge when a moment sits on it', () => {
    // 44px, and the number is not the tap target by coincidence: it is
    // what keeps the extent and the type visible under a nappy.
    const layout = lay([
      entry(night()),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 21, 30) })),
    ]);

    expect(layout.pins[0]?.left as number * WIDE).toBeGreaterThanOrEqual(SPAN_KEEP);
    expect(layout.pins[0]?.overSpan).toBe(true);
  });

  it('leaves a range its whole label zone when a moment lands at its top', () => {
    // The words of a range are never covered. Without this the tier would
    // depend on the coverage, the coverage on how wide the moments are, and
    // the moments on the tier.
    const layout = lay([
      entry(night()),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 20, 5) })),
    ]);

    expect(layout.pins[0]?.left as number * WIDE).toBeGreaterThanOrEqual(labelWidthFor(WIDE));
    expect(layout.spans[0]?.labelWidth).toBeGreaterThanOrEqual(labelWidthFor(WIDE));
  });

  it('gives every range at least its label width, however busy the hour', () => {
    const layout = lay([
      entry(night()),
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 20, 2) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 20, 6) })),
      entry(event({ id: 'c', typeId: 'bottle', startedAt: at(DAY, 20, 10) })),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 20, 14) })),
    ]);

    for (const span of layout.spans) {
      expect(span.labelWidth).toBeGreaterThanOrEqual(Math.min(labelWidthFor(WIDE), span.width * WIDE));
    }
  });

  it('does not reserve anything under a range that has finished', () => {
    // The nappy is two hours after the night ended, so it has the band.
    const layout = lay([
      entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 10) })),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 12) })),
    ]);

    expect(layout.pins[0]).toMatchObject({ left: 0, width: 1, overSpan: false });
  });
});

describe('what merges, and what bounds it', () => {
  const HALF = 173;
  const lay = (entries: DayEntry[], band: number) =>
    layOut(items(entries), DEFAULT_METRICS, band);

  const many = (hour: number, count: number, from = 0): DayEntry[] =>
    Array.from({ length: count }, (_, i) =>
      entry(event({
        id: `${hour}-${from}-${i}`, typeId: 'diaper', startedAt: at(DAY, hour, from + i),
      })));

  it('merges nothing at all while there is room', () => {
    const layout = lay(many(9, 3), 346);
    expect(layout.chips).toEqual([]);
    expect(layout.pins).toHaveLength(3);
  });

  it('offers an entry once the width has genuinely run out', () => {
    const layout = lay(many(9, 6), HALF);
    expect(layout.chips.length).toBeGreaterThan(0);
    // And nothing is dropped: every record is either placed or in an entry.
    const held = layout.chips.flatMap((chip) => chip.members).length + layout.pins.length;
    expect(held).toBe(6);
  });

  it('never merges across a clock hour, however crowded either one is', () => {
    // The owner's rule, and the one thing about a merge that is visible on
    // the axis: an eight o'clock record and an eleven o'clock record can
    // never be behind the same entry.
    const layout = lay([...many(8, 6), ...many(11, 6)], HALF);

    expect(layout.chips.length).toBeGreaterThanOrEqual(2);
    for (const chip of layout.chips) {
      const hours = new Set(chip.members.map((one) => Math.floor(one.startMin / 60)));
      expect([...hours]).toEqual([chip.hour]);
    }
  });

  it('never merges two moments four minutes apart across an hour boundary', () => {
    // 17:58 and 18:02 are four minutes apart and in different hours, so
    // they compete for columns and never share an entry. That is the price
    // of a bound somebody can see, and it is worth paying.
    const layout = lay([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 17, 58) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 18, 2) })),
    ], HALF);

    expect(layout.chips).toEqual([]);
    expect(layout.pins).toHaveLength(2);
  });

  it('gives a clock hour one entry for the whole day, not one per huddle', () => {
    // Five at 09:00 and five at 09:40 do not overlap, so they are laid out
    // as two separate stretches -- but they are one hour, and an hour is
    // one entry. Folded separately they became two entries with the same
    // name, and pressing either opened both, on top of each other.
    const layout = lay([...many(9, 5), ...many(9, 5, 40)], HALF);

    expect(layout.chips).toHaveLength(1);
    expect(layout.chips[0]?.members).toHaveLength(10);
    expect(new Set(layout.chips.map((chip) => chip.hour)).size).toBe(layout.chips.length);
  });

  it('is as tall as it is drawn, so the record below it is clear', () => {
    // The entry carries three rows whatever the stretch it covers, so five
    // records in one minute is still 58px on the screen. Colliding against
    // 44px while drawing 58 put ten pixels of it over the next card.
    // The next record is in the *next* hour, so it cannot be folded in --
    // it has to be laid out around the entry instead.
    const layout = lay([...many(9, 5, 40), entry(event({
      id: 'after', typeId: 'bottle', startedAt: at(DAY, 10, 10),
    }))], 346);

    const chip = layout.chips[0];
    expect(chip?.height).toBeGreaterThanOrEqual(CHIP_HEIGHT);

    // Thirty minutes is 48px, so the two do collide -- and the layout has
    // to have noticed.
    const after = layout.pins.find((one) => one.item.eventId === 'after');
    expect(minutesToPx(30, DEFAULT_METRICS)).toBeLessThan(CHIP_HEIGHT);
    expect(after!.left).not.toBe(chip!.left);
  });

  it('does not make an entry out of one record', () => {
    // A list of one is not a list; it takes the column it was heading for.
    const layout = lay(many(9, 4), HALF);
    for (const chip of layout.chips) expect(chip.members.length).toBeGreaterThan(1);
  });

  it('holds its members in the order they happened', () => {
    const layout = lay(many(9, 6), HALF);
    for (const chip of layout.chips) {
      const starts = chip.members.map((one) => one.startMin);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    }
  });
});

describe('nothing is ever placed past the edge of the band', () => {
  // Reported from a real iPhone: the screen had to be swiped sideways to
  // read it. Nothing in the suite caught it, because jsdom's window is
  // 1024px wide and the arithmetic only goes wrong once the reserved width
  // for a range's words is a large share of the band -- which is every
  // phone, and every two-day column on one.
  const days: Record<string, DayEntry[]> = {
    'a night with two moments on it': [
      entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 20), endedAt: at(DAY, 23) })),
      entry(event({ id: 'n', typeId: 'nursing', startedAt: at(DAY, 20, 30), endedAt: at(DAY, 21) })),
      entry(event({ id: 'd', typeId: 'diaper', startedAt: at(DAY, 20, 35) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 20, 40) })),
    ],
    'an hour with more moments than fit': Array.from({ length: 8 }, (_, i) =>
      entry(event({ id: `m${i}`, typeId: 'diaper', startedAt: at(DAY, 9, i * 2) }))),
    // The one shape that cannot be folded out of trouble: two moments in
    // different clock hours, under a range that has taken the reserve. They
    // may not merge, so the columns have to get narrower -- and narrower
    // columns are where the arithmetic goes past the edge.
    'two moments either side of an hour, under a range': [
      entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 17, 50), endedAt: at(DAY, 19, 20) })),
      entry(event({ id: 'p1', typeId: 'bottle', startedAt: at(DAY, 17, 58) })),
      entry(event({ id: 'p2', typeId: 'diaper', startedAt: at(DAY, 18, 2) })),
    ],
    'an entry with the next hour just below it': [
      ...Array.from({ length: 5 }, (_, i) =>
        entry(event({ id: `h${i}`, typeId: 'diaper', startedAt: at(DAY, 9, 40 + i) }))),
      entry(event({ id: 'after', typeId: 'bottle', startedAt: at(DAY, 10, 10) })),
    ],
    'two huddles in one hour': [
      ...Array.from({ length: 5 }, (_, i) =>
        entry(event({ id: `a${i}`, typeId: 'diaper', startedAt: at(DAY, 9, i) }))),
      ...Array.from({ length: 5 }, (_, i) =>
        entry(event({ id: `b${i}`, typeId: 'bottle', startedAt: at(DAY, 9, 40 + i) }))),
    ],
    'three ranges at once': [
      entry(event({ id: 'x', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 12) })),
      entry(event({ id: 'y', typeId: 'walk', startedAt: at(DAY, 9, 30), endedAt: at(DAY, 11) })),
      entry(event({ id: 'z', typeId: 'bath', startedAt: at(DAY, 10), endedAt: at(DAY, 10, 30) })),
    ],
  };

  for (const [what, entries] of Object.entries(days)) {
    it(`keeps ${what} inside every width a phone can be`, () => {
      for (const band of [110, 130, 150, 173, 200, 250, 300, 346, 500]) {
        const layout = layOut(items(entries), DEFAULT_METRICS, band);
        for (const one of [...layout.spans, ...layout.pins, ...layout.chips]) {
          const name = 'item' in one ? one.item.typeId : `chip@${one.hour}`;
          expect(one.left, `${name} at ${band}`).toBeGreaterThanOrEqual(0);
          expect(one.left + one.width, `${name} at ${band}`).toBeLessThanOrEqual(1.0001);
        }
      }
    });
  }
});

describe('more ranges at once than there is room for', () => {
  it('makes them narrow, and never hides one', () => {
    // Back-filled ranges are not limited the way a running timer is
    // (spec 3.5 constrains `active = 1` and nothing else), so this is a
    // day somebody can really write. Every one of them keeps a block.
    const overlapping = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
      entry(event({
        id, typeId: 'sleep', startedAt: at(DAY, 9, i), endedAt: at(DAY, 11),
      })));
    const layout = layOut(items(overlapping), DEFAULT_METRICS, 173);

    expect(layout.spans).toHaveLength(5);
    expect(layout.chips).toEqual([]);
    for (const span of layout.spans) {
      expect(span.width).toBeCloseTo(1 / 5, 10);
      expect(span.left + span.width).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe('nothing is ever drawn on top of anything else', () => {
  // Reported by review, with two reproductions. Both came out with cards
  // sharing space: the first because a range's card can be bigger than the
  // range, the second because a record that found no column was put back
  // into the last one regardless of what was already there.
  const rect = (one: { top: number; height: number; left: number; width: number }) =>
    ({ top: one.top, bottom: one.top + one.height, left: one.left, right: one.left + one.width });

  const clash = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>): boolean =>
    a.top < b.bottom - 0.001 && b.top < a.bottom - 0.001
    && a.left < b.right - 0.0001 && b.left < a.right - 0.0001;

  /**
   * Within a lane, nothing may share space with anything.
   *
   * Across the two lanes it may: a moment over a range is the point of
   * `overSpan`, and what protects the range there is `SPAN_KEEP` rather
   * than separation. So the check is per lane, which is exactly where both
   * reported collisions were.
   */
  const noneClash = (entries: DayEntry[], band: number): void => {
    const layout = layOut(items(entries), DEFAULT_METRICS, band);
    const lanes = [layout.spans.map(rect), [...layout.pins, ...layout.chips].map(rect)];

    for (const [lane, boxes] of lanes.entries()) {
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          expect(
            clash(boxes[i] as never, boxes[j] as never),
            `lane ${lane}, ${i} and ${j}, at ${band}px`,
          ).toBe(false);
        }
      }
    }
  };

  it('keeps two five-minute ranges ten minutes apart apart', () => {
    for (const band of [110, 173, 250, 346]) {
      noneClash([
        entry(event({ id: 'a', typeId: 'nursing', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 5) })),
        entry(event({ id: 'b', typeId: 'nursing', startedAt: at(DAY, 9, 10), endedAt: at(DAY, 9, 15) })),
      ], band);
    }
  });

  it('keeps two moments either side of an hour boundary apart, under a range', () => {
    // 17:58 and 18:02 cannot merge -- different clock hours -- and with a
    // range under them there is room for one column. They must each get
    // narrower, not share the same place.
    for (const band of [110, 173, 250, 346]) {
      noneClash([
        entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 17, 50), endedAt: at(DAY, 19, 20) })),
        entry(event({ id: 'p1', typeId: 'bottle', startedAt: at(DAY, 17, 58) })),
        entry(event({ id: 'p2', typeId: 'diaper', startedAt: at(DAY, 18, 2) })),
      ], band);
    }
  });

  it('keeps a whole busy evening apart at every width', () => {
    const evening: DayEntry[] = [
      entry(event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 20), endedAt: at(DAY, 23, 30) })),
      entry(event({ id: 'temp', typeId: 'temperature', startedAt: at(DAY, 20, 21) })),
      entry(event({ id: 'nap', typeId: 'nursing', startedAt: at(DAY, 20, 30), endedAt: at(DAY, 20, 38) })),
      entry(event({ id: 'd1', typeId: 'diaper', startedAt: at(DAY, 22, 50) })),
      entry(event({ id: 'n1', typeId: 'nursing', startedAt: at(DAY, 22, 50), endedAt: at(DAY, 22, 58) })),
      entry(event({ id: 'b1', typeId: 'bottle', startedAt: at(DAY, 22, 58) })),
      entry(event({ id: 'b2', typeId: 'bottle', startedAt: at(DAY, 23, 2) })),
    ];
    for (const band of [110, 130, 173, 200, 250, 300, 346, 500]) noneClash(evening, band);
  });
});

describe('the evening that used to be one grey rectangle', () => {
  // The stretch from the screenshot, at a phone's single-day width: a solid
  // feed, a walk, two nappies, a five-hour nursing and a stopped timer.
  const WIDE = 346;
  const evening = (): DayEntry[] => [
    entry(event({ id: 'solid', typeId: 'solid_food', startedAt: at(DAY, 16, 27) })),
    entry(event({ id: 'walk', typeId: 'walk', startedAt: at(DAY, 16, 44), endedAt: at(DAY, 17, 10) })),
    entry(event({ id: 'nappy1', typeId: 'diaper', startedAt: at(DAY, 17, 6) })),
    entry(event({ id: 'nursing', typeId: 'nursing', startedAt: at(DAY, 17, 24), endedAt: at(DAY, 23, 11) })),
    entry(event({ id: 'nappy2', typeId: 'diaper', startedAt: at(DAY, 17, 24) })),
  ];

  it('draws all six of them, and collapses none', () => {
    const layout = layOut(items(evening()), DEFAULT_METRICS, WIDE);
    expect(layout.chips).toEqual([]);
    expect(layout.spans.length + layout.pins.length).toBe(5);
  });

  it('leaves the five-hour nursing its own block and its own words', () => {
    const layout = layOut(items(evening()), DEFAULT_METRICS, WIDE);
    const nursing = layout.spans.find((one) => one.item.eventId === 'nursing');

    // Its extent, in full, and enough width to say what it is.
    expect(nursing?.extentPx).toBeCloseTo(minutesToPx(5 * 60 + 47, DEFAULT_METRICS), 6);
    expect(nursing?.labelWidth).toBeGreaterThanOrEqual(labelWidthFor(WIDE));
    // Wide enough for the one number a range is there to carry.
    expect(nursing?.labelWidth).toBeGreaterThan(
      textWidth('\u4e0b\u53485:24', 10) + textWidth(' \u00b7 ', 10) + textWidth('5 \u5c0f\u6642 47 \u5206', 10) + 15,
    );
  });

  it('does not let a nappy at 17:06 narrow a range that starts at 17:24', () => {
    // They do not overlap in time at all. Under the old model the nappy's
    // card box did overlap, which put the nursing in a third of the band
    // and then the whole evening behind one button.
    const layout = layOut(items(evening()), DEFAULT_METRICS, WIDE);
    const nursing = layout.spans.find((one) => one.item.eventId === 'nursing');
    expect(nursing?.width).toBe(1);
    // The walk is 26 minutes, so its card is bigger than it is and it is
    // laid out among the moments -- where it also narrows nothing.
    expect(layout.pins.some((one) => one.item.eventId === 'walk')).toBe(true);
  });
});

describe('the extent is the duration, and the card is not', () => {
  const only = (e: EventDto): never => items([entry(e)])[0] as never;
  const HOUR_PX = DEFAULT_METRICS.hourHeight;

  it('draws a finished range as exactly the minutes it lasted', () => {
    // The whole question a timeline answers. An hour is an hour of axis, and
    // five hours and forty-seven minutes is five hours and forty-seven
    // minutes of axis -- not the height of whatever words sit in it.
    const hour = extentOf(only(event({
      id: 'a', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 10),
    })), DEFAULT_METRICS);
    expect(hour).toMatchObject({ px: HOUR_PX, point: false });

    const long = extentOf(only(event({
      id: 'b', typeId: 'nursing', startedAt: at(DAY, 17, 24), endedAt: at(DAY, 23, 11),
    })), DEFAULT_METRICS);
    expect(long.px).toBeCloseTo(minutesToPx(5 * 60 + 47, DEFAULT_METRICS), 10);
    expect(long.px / HOUR_PX).toBeCloseTo(347 / 60, 10);
  });

  it('is never stretched to fit the words beside it', () => {
    // The card has a minimum height and the extent does not share it. A
    // twenty-minute nap is twenty minutes of stripe inside a card of
    // forty-four pixels, which is the trap spec 7.5 names: the card's own
    // height must never be readable as a duration.
    const nap = only(event({
      id: 'n', typeId: 'sleep', startedAt: at(DAY, 14), endedAt: at(DAY, 14, 20),
    }));
    const stripe = extentOf(nap, DEFAULT_METRICS);
    const box = boxOf(nap, DEFAULT_METRICS);

    expect(stripe.px).toBeCloseTo(minutesToPx(20, DEFAULT_METRICS), 10);
    expect(minutesToPx(box.bottom - box.top, DEFAULT_METRICS)).toBe(DEFAULT_METRICS.minCardHeight);
    expect(stripe.px).toBeLessThan(DEFAULT_METRICS.minCardHeight);
  });

  it('gives a moment no tint at all, rather than a little of one', () => {
    // Zero is not a very small duration. A moment's card carries no colour
    // in it whatever, because any amount of colour would be a length
    // nobody recorded -- which is also how the two kinds are told apart.
    const bottle = extentOf(only(event({
      id: 'b', typeId: 'bottle', startedAt: at(DAY, 16, 20),
    })), DEFAULT_METRICS);

    expect(bottle).toEqual({ px: 0, point: true });
  });

  it('gives a running timer and an unfinished record no tint either', () => {
    // Neither has a length that is a fact yet (spec 3.4.1 rule 3).
    const running = extentOf(only(event({
      id: 'r', typeId: 'sleep', startedAt: at(DAY, 13), active: true,
    })), DEFAULT_METRICS);
    const unfinished = extentOf(only(event({
      id: 'u', typeId: 'sleep', startedAt: at(DAY, 13), endedAt: null,
    })), DEFAULT_METRICS);

    expect(running.point).toBe(true);
    expect(unfinished.point).toBe(true);
  });

  it('keeps a two-minute feed visible without inventing minutes', () => {
    // The one place the drawing departs from the clock, and only upwards
    // from nothing: three pixels is under two minutes at these metrics.
    const brief = extentOf(only(event({
      id: 's', typeId: 'nursing', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 1),
    })), DEFAULT_METRICS);

    expect(brief.px).toBe(MIN_EXTENT_PX);
    expect((MIN_EXTENT_PX / HOUR_PX) * 60).toBeLessThan(2);
    // And nothing above the floor is touched by it.
    const ten = extentOf(only(event({
      id: 't', typeId: 'nursing', startedAt: at(DAY, 9), endedAt: at(DAY, 9, 10),
    })), DEFAULT_METRICS);
    expect(ten.px).toBeCloseTo(minutesToPx(10, DEFAULT_METRICS), 10);
  });

  it('draws only the part of a night that falls on the day being looked at', () => {
    const overnight = event({
      id: 'n', typeId: 'sleep', startedAt: at(DAY, 23), endedAt: at(NEXT, 7), localDate: DAY,
    });
    const evening = extentOf(only(overnight), DEFAULT_METRICS);
    const morning = extentOf(
      items([entry(overnight, true)], [], [], NEXT)[0] as never,
      DEFAULT_METRICS,
    );

    expect(evening.px).toBe(HOUR_PX);
    expect(morning.px).toBe(7 * HOUR_PX);
  });
});

describe('how tall an hour is', () => {
  it('is 96 pixels, which is what stops half an hour reading as a collision', () => {
    // A fingertip is 44px whatever the axis does, so the hour height decides
    // how many *minutes* a fingertip covers. At 64 it covered 41, and two
    // records half an hour apart -- with nothing at all between them --
    // collided as cards and were laid out as if they were simultaneous. That
    // spurious collision is what chained an evening into one group and then
    // collapsed the lot (docs/timeline-design.md).
    expect(DEFAULT_METRICS.hourHeight).toBe(96);
    expect(minCardMinutes(DEFAULT_METRICS)).toBeCloseTo(27.5, 10);
  });

  it('leaves two records half an hour apart alone, which 64 did not', () => {
    // The regression test for the metric itself, from the fixtures: a bottle
    // at 05:40 and a nappy at 06:10.
    const pair = items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 5, 40) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 6, 10) })),
    ]);

    // Two full-width cards at 96, two half-width ones at 64.
    expect(layOut(pair, DEFAULT_METRICS, 346).pins.map((one) => one.width)).toEqual([1, 1]);
    expect(layOut(pair, { ...DEFAULT_METRICS, hourHeight: 64 }, 346).pins.map((one) => one.width))
      .toEqual([0.5, 0.5]);
  });

  it('still puts ten minutes apart side by side, because they are', () => {
    // No hour height fixes this one short of 264px an hour, and side by side
    // is the right answer for it.
    const pair = items([
      entry(event({ id: 'a', typeId: 'diaper', startedAt: at(DAY, 5, 59) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 6, 9) })),
    ]);
    expect(layOut(pair, DEFAULT_METRICS, 346).pins.map((one) => one.width)).toEqual([0.5, 0.5]);
  });
});

describe('roughly how wide a string is', () => {
  it('counts a CJK glyph as wider than a digit', () => {
    // The estimate exists so a card can decide whether it can carry a thing
    // at all. It is allowed to be a few pixels out; it is not allowed to
    // think two Chinese characters are the width of two digits.
    expect(textWidth('\u5206', 10)).toBeGreaterThan(textWidth('7', 10));
    expect(textWidth('\u4e0b\u5348', 10)).toBeCloseTo(20, 5);
  });

  it('is in the right neighbourhood for the strings cards actually carry', () => {
    // Measured in the browser at 10px: the clock is around 40px and a long
    // duration around 55. Both within a few pixels here, which is all the
    // callers need -- each leaves a margin.
    expect(textWidth('\u4e0b\u53485:24', 10)).toBeGreaterThan(30);
    expect(textWidth('\u4e0b\u53485:24', 10)).toBeLessThan(50);
    expect(textWidth('5 \u5c0f\u6642 47 \u5206', 10)).toBeGreaterThan(45);
    expect(textWidth('5 \u5c0f\u6642 47 \u5206', 10)).toBeLessThan(70);
  });

  it('grows with the font size, and is zero for nothing', () => {
    expect(textWidth('abc', 20)).toBe(textWidth('abc', 10) * 2);
    expect(textWidth('', 12)).toBe(0);
  });
});

describe('how much a card can say at its width', () => {
  it('drops words as it narrows, and never the clock', () => {
    // A card degrades by saying less, not by disappearing. The badge is the
    // last thing to go because it is the only thing that says which type
    // (docs/timeline-design.md).
    expect(tierFor(346)).toBe('A');
    expect(tierFor(160)).toBe('A');
    expect(tierFor(159)).toBe('B');
    expect(tierFor(96)).toBe('B');
    expect(tierFor(95)).toBe('C');
    expect(tierFor(64)).toBe('C');
    expect(tierFor(63)).toBe('D');
    expect(tierFor(48)).toBe('D');
  });

  it('calls a half-width two-day column readable', () => {
    // 390px phone, less the 44px hour labels, halved: 173px. That is the
    // default width of the two-day screen and it has to carry a name.
    expect(tierFor((390 - 44) / 2)).toBe('A');
    // And two cards inside one of those columns still say type and value.
    expect(tierFor((390 - 44) / 2 / 2 - 4)).toBe('C');
  });
});

describe('the card is not the duration', () => {
  it('gives a moment a card taller than its length, and keeps the length at zero', () => {
    // The trap spec 7.5 names: a minimum card height that reads as a
    // duration. The box is what stops cards colliding; `lengthMin` is what
    // the drawing of the event itself uses, and they are different numbers.
    const [bottle] = items([entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 9) }))]);
    const box = boxOf(bottle as never, DEFAULT_METRICS);

    expect(bottle?.lengthMin).toBe(0);
    expect(box.bottom - box.top).toBe(minCardMinutes(DEFAULT_METRICS));
  });

  it('leaves a long event its own extent', () => {
    const [sleep] = items([
      entry(event({ id: 's', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 12) })),
    ]);
    const box = boxOf(sleep as never, DEFAULT_METRICS);
    expect(box.bottom - box.top).toBe(180);
  });
});

describe('records this device is still holding', () => {
  it('places a queued add by its own time, marked as unsent', () => {
    const [only] = items([], [queued({ typeId: 'bottle', startedAt: at(DAY, 16, 20) })]);
    expect(only).toMatchObject({ kind: 'queued', startMin: 16 * 60 + 20, eventId: null });
  });

  it('shows one copy, not two, once the same record has arrived', () => {
    // Between the queue dropping an entry and both stores being read again,
    // each holds a copy (spec 6.2).
    const stored = event({ id: 'same', typeId: 'bottle', startedAt: at(DAY, 16) });
    const both = items([entry(stored)], [queued({ typeId: 'bottle', startedAt: at(DAY, 16) }, 'same')]);

    expect(both).toHaveLength(1);
    expect(both[0]?.kind).toBe('event');
  });

  it('leaves out a queued add belonging to another day', () => {
    const [nothing] = items([], [queued({ typeId: 'bottle', startedAt: at(NEXT, 9) })]);
    expect(nothing).toBeUndefined();
  });
});

describe('an unsent record that crossed midnight', () => {
  const overnight = queued({
    typeId: 'sleep',
    startedAt: at(DAY, 23),
    endedAt: at(NEXT, 7),
  }, 'q-night');

  it('shows its morning half on the morning, not only its evening half', () => {
    // Written up offline, it is in the outbox and nowhere else. Keeping only
    // the entries that *start* on the day made the morning invisible until
    // the queue drained, and then seven hours appeared from nowhere.
    const [morning] = items([], [overnight], [], NEXT);

    expect(morning).toMatchObject({
      kind: 'queued', startMin: 0, lengthMin: 7 * 60, carriedOver: true,
    });
  });

  it('shows its evening half on the evening', () => {
    const [evening] = items([], [overnight]);
    expect(evening).toMatchObject({ startMin: 23 * 60, lengthMin: 60, continues: true });
  });

  it('leaves nothing on the next day when it ends exactly at midnight', () => {
    const toMidnight = queued({
      typeId: 'sleep', startedAt: at(DAY, 23), endedAt: at(NEXT, 0),
    }, 'q-mid');

    expect(items([], [toMidnight], [], NEXT)).toEqual([]);
    expect(items([], [toMidnight])).toHaveLength(1);
  });

  it('still leaves out one belonging to another day entirely', () => {
    const elsewhere = queued({ typeId: 'bottle', startedAt: at(NEXT, 9) }, 'q-other');
    expect(items([], [elsewhere])).toEqual([]);
  });

  it('is still shown once when the same record has arrived', () => {
    const stored = event({
      id: 'q-night', typeId: 'sleep', startedAt: at(DAY, 23), endedAt: at(NEXT, 7), localDate: DAY,
    });
    const both = items([entry(stored, true)], [overnight], [], NEXT);

    expect(both).toHaveLength(1);
    expect(both[0]?.kind).toBe('event');
  });
});

describe('a timer stopped here, with nobody having confirmed when', () => {
  const running = event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 13), active: true });

  it('is drawn ending where the button was pressed, not still running', () => {
    const [only] = items([entry(running)], [], [draft('sleep', at(DAY, 14, 30))]);

    expect(only).toMatchObject({
      kind: 'draft', drafted: true, running: false, startMin: 13 * 60, lengthMin: 90,
    });
    // And it carries the draft's own moment. The event the server knows
    // about is a running timer with no end at all, so reading `endedAt` off
    // it gives null -- which a clock formats as the epoch.
    expect(only?.draftEndedAt).toBe(at(DAY, 14, 30));
    expect(only?.event?.endedAt).toBeNull();
  });

  it('is clipped to the day like anything else', () => {
    const late = event({ id: 'late', typeId: 'sleep', startedAt: at(DAY, 23), active: true });
    const [only] = items([entry(late)], [], [draft('late', at(NEXT, 2))]);

    expect(only).toMatchObject({ startMin: 23 * 60, lengthMin: 60, continues: true });
  });

  it('says the time needs correcting when the draft is longer than allowed', () => {
    // A timer forgotten overnight stops at a moment the server will refuse,
    // so offering a plain confirmation would offer something that cannot
    // work (spec 7.2, 3.4.1 rule 1).
    const [only] = items(
      [entry(running)],
      [],
      [draft('sleep', running.startedAt + MAX_EVENT_DURATION_MS + 60_000)],
    );
    expect(only?.draftTooLong).toBe(true);
  });

  it('does not say that of a draft inside the limit', () => {
    const [only] = items([entry(running)], [], [draft('sleep', at(DAY, 14))]);
    expect(only?.draftTooLong).toBe(false);
  });
});

describe('where a day opens', () => {
  const layout = layOut(items([
    entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 7, 30) })),
    entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 15) })),
  ]), DEFAULT_METRICS, 346);

  it('opens today near the current hour', () => {
    expect(openingMinute(true, 13 * 60, layout)).toBe(13 * 60);
  });

  it('opens any other day on its first record', () => {
    // The top of an empty night is not where the day is.
    expect(openingMinute(false, null, layout)).toBe(7 * 60 + 30);
  });

  it('has nowhere in particular to go on an empty day', () => {
    expect(openingMinute(false, null, layOut([], DEFAULT_METRICS, 346))).toBeNull();
  });
});

describe('the axis itself', () => {
  it('is a whole day, however little happened on it', () => {
    expect(MINUTES_IN_DAY).toBe(1440);
    expect(startOfLocalDay(DAY, TZ) + MINUTES_IN_DAY * 60_000).toBe(startOfLocalDay(NEXT, TZ));
  });

  it('does not move an hour to make room', () => {
    // Nothing in the layout changes where an hour is. Two events six hours
    // apart stay six hours apart whatever is between them.
    const layout = layOut(items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 3) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 9) })),
    ]), DEFAULT_METRICS, 346);

    const [first, second] = layout.pins;
    expect(second!.top - first!.top).toBe(minutesToPx(6 * 60, DEFAULT_METRICS));
  });
});
