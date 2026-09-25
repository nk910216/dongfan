import { describe, expect, it } from 'vitest';
import { MAX_EVENT_DURATION_MS, localToUtc, startOfLocalDay } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import type { DayEntry, QueuedCreate, StopDraft } from '../src/lib/db.js';
import {
  DEFAULT_METRICS, MINUTES_IN_DAY, boxOf, columnSpan, itemsFor, layOut, minCardMinutes,
  openingMinute, splitAllDay,
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
    expect(layout.clusters).toEqual([]);
  });
});

describe('two things at once', () => {
  it('puts genuinely overlapping ranges in separate columns', () => {
    const layout = layOut(items([
      entry(event({ id: 'sleep', typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 11) })),
      entry(event({ id: 'walk', typeId: 'walk', startedAt: at(DAY, 10), endedAt: at(DAY, 12) })),
    ]));

    expect(layout.clusters).toHaveLength(1);
    const columns = layout.clusters[0]?.placed.map((p) => p.column);
    expect(columns).toEqual([0, 1]);
    expect(layout.clusters[0]?.placed[0]?.columns).toBe(2);
  });

  it('separates moments that do not overlap in time but would on screen', () => {
    // Two bottles four minutes apart have no overlap at all, and their cards
    // do. Spec 7.5 asks for both kinds to be laid out, which is why the
    // card's extent decides this and not the duration.
    const minimum = minCardMinutes(DEFAULT_METRICS);
    expect(minimum).toBeGreaterThan(4);

    const layout = layOut(items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 9) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 9, 4) })),
    ]));

    expect(layout.clusters[0]?.placed.map((p) => p.column)).toEqual([0, 1]);
  });

  it('reuses a column once the card above it has finished', () => {
    // A card covers 41 minutes of axis at the default metrics, so the third
    // here is clear of the first (09:00) and still caught by the second
    // (09:04). It goes back to column 0 rather than starting a third and
    // squeezing the words.
    const layout = layOut(items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 9) })),
      entry(event({ id: 'b', typeId: 'diaper', startedAt: at(DAY, 9, 4) })),
      entry(event({ id: 'c', typeId: 'bottle', startedAt: at(DAY, 9, 42) })),
    ]));

    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]?.placed.map((p) => p.column)).toEqual([0, 1, 0]);
    expect(layout.clusters[0]?.crowded).toBe(false);
  });

  it('starts a new cluster once nothing is left to collide with', () => {
    const layout = layOut(items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 9) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 9, 50) })),
    ]));

    expect(layout.clusters).toHaveLength(2);
    expect(layout.clusters.map((c) => c.placed.length)).toEqual([1, 1]);
  });

  it('leaves things that do not collide in separate clusters', () => {
    const layout = layOut(items([
      entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 9) })),
      entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 15) })),
    ]));

    expect(layout.clusters).toHaveLength(2);
    expect(layout.clusters.every((c) => c.placed.length === 1)).toBe(true);
  });

  it('says when a stretch is too crowded for a phone, without dropping any', () => {
    // Four at once is past what fits beside each other. The cluster is
    // marked, the screen offers a way in, and every one of them is still
    // here (spec 7.5).
    const layout = layOut(items(
      ['a', 'b', 'c', 'd'].map((id, i) =>
        entry(event({ id, typeId: 'bottle', startedAt: at(DAY, 9, i) }))),
    ));

    expect(layout.clusters).toHaveLength(1);
    expect(layout.clusters[0]?.crowded).toBe(true);
    expect(layout.clusters[0]?.placed).toHaveLength(4);
  });

  it('does not call three crowded', () => {
    const layout = layOut(items(
      ['a', 'b', 'c'].map((id, i) => entry(event({ id, typeId: 'bottle', startedAt: at(DAY, 9, i) }))),
    ));
    expect(layout.clusters[0]?.crowded).toBe(false);
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

describe('how wide a column is', () => {
  it('divides the event area and never reaches past its right edge', () => {
    // The fractions are of the space left after the hour labels. Adding that
    // strip to the offset while still dividing the full width put a single
    // column 40px past the edge, and the last of any row with it.
    for (const columns of [1, 2, 3, 4]) {
      for (let column = 0; column < columns; column += 1) {
        const span = columnSpan({ item: {} as never, column, columns });
        expect(span.left, `${column}/${columns}`).toBeGreaterThanOrEqual(0);
        expect(span.left + span.width, `${column}/${columns}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives the columns of a row equal, non-overlapping shares', () => {
    const spans = [0, 1, 2].map((column) => columnSpan({ item: {} as never, column, columns: 3 }));
    expect(spans.map((s) => s.width)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(spans[1]!.left).toBeCloseTo(spans[0]!.left + spans[0]!.width, 10);
    expect(spans[2]!.left).toBeCloseTo(spans[1]!.left + spans[1]!.width, 10);
  });
});

describe('where a day opens', () => {
  const layout = layOut(items([
    entry(event({ id: 'a', typeId: 'bottle', startedAt: at(DAY, 7, 30) })),
    entry(event({ id: 'b', typeId: 'bottle', startedAt: at(DAY, 15) })),
  ]));

  it('opens today near the current hour', () => {
    expect(openingMinute(true, 13 * 60, layout)).toBe(13 * 60);
  });

  it('opens any other day on its first record', () => {
    // The top of an empty night is not where the day is.
    expect(openingMinute(false, null, layout)).toBe(7 * 60 + 30);
  });

  it('has nowhere in particular to go on an empty day', () => {
    expect(openingMinute(false, null, layOut([]))).toBeNull();
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
    ]));

    const [first, second] = layout.clusters;
    expect(second!.fromMin - first!.fromMin).toBe(6 * 60);
  });
});
