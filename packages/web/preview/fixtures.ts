import { startOfLocalDay } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import type { DayEntry, QueuedCreate, StopDraft } from '../src/lib/db.js';

/**
 * An invented pair of days, for looking at the timeline on a narrow screen.
 *
 * Every record here is made up. Nothing reads a database, and nothing in
 * this folder is part of the app that gets built -- it exists because the
 * failures this layout has are geometric, and jsdom lays nothing out: a card
 * clipped into a speck, words an hour below the line they belong to and a
 * type name cut to one character all pass every assertion in the suite.
 *
 * The pair covers what the rules are about: a night across midnight, a long
 * range, moments minutes apart, a stretch too crowded for the width, an
 * all-day record, an unsent add and a stop nobody has confirmed.
 */

export const TZ = 'Asia/Taipei';
export const EARLIER = '2026-09-24';
export const LATER = '2026-09-25';

const at = (date: string, hour: number, minute = 0): number =>
  startOfLocalDay(date, TZ) + hour * 3_600_000 + minute * 60_000;

let next = 0;

function event(
  typeId: string,
  date: string,
  from: [number, number],
  to: [string, number, number] | null = null,
  over: Partial<EventDto> = {},
): EventDto {
  next += 1;
  return {
    id: `preview-${next}`,
    babyId: 'baby',
    typeId,
    createdBy: 'parent',
    createdAt: 0,
    updatedAt: 0,
    startedAt: at(date, from[0], from[1]),
    endedAt: to === null ? null : at(to[0], to[1], to[2]),
    localDate: date,
    value: null,
    note: '',
    metadata: {},
    version: 1,
    rev: 1,
    active: false,
    deletedAt: null,
    tagIds: [],
    ...over,
  } as EventDto;
}

const on = (e: EventDto): DayEntry => ({ event: e, carriedOver: false });
const from = (e: EventDto): DayEntry => ({ event: e, carriedOver: true });

/** A night begun on the earlier day and ended on the later one. */
const night = event('sleep', EARLIER, [20, 34], [LATER, 5, 30]);

/** A timer the server still thinks is running, stopped on this device. */
const stopped = event('sleep', LATER, [21, 0], null, { active: true, version: 3 });

export const EARLIER_DAY: DayEntry[] = [
  on(event('nursing', EARLIER, [0, 10], [EARLIER, 0, 22])),
  on(event('diaper', EARLIER, [0, 45])),
  on(event('sleep', EARLIER, [2, 30], [EARLIER, 6, 10])),
  on(event('bottle', EARLIER, [6, 20], null, { value: 140 })),
  on(event('diaper', EARLIER, [7, 0])),
  on(event('solid_food', EARLIER, [8, 30])),
  on(event('sleep', EARLIER, [13, 41], [EARLIER, 15, 12])),
  on(event('pumping', EARLIER, [16, 7], [EARLIER, 16, 24], { value: 170 })),
  on(event('walk', EARLIER, [16, 35], [EARLIER, 17, 5])),
  on(event('diaper', EARLIER, [16, 42])),
  on(event('solid_food', EARLIER, [17, 42])),
  on(event('mood_sad', EARLIER, [18, 19])),
  on(event('diaper', EARLIER, [18, 27])),
  on(event('bath', EARLIER, [19, 3], [EARLIER, 19, 20])),
  on(event('bottle', EARLIER, [19, 35], null, { value: 223 })),
  on(event('temperature', EARLIER, [20, 21], null, { value: 365 })),
  on(night),
  on(event('diaper', EARLIER, [22, 50])),
  on(event('nursing', EARLIER, [22, 50], [EARLIER, 22, 58])),
  on(event('bottle', EARLIER, [22, 58], null, { value: 140 })),
];

export const LATER_DAY: DayEntry[] = [
  from(night),
  on(event('bottle', LATER, [5, 40], null, { value: 120 })),
  on(event('diaper', LATER, [6, 10])),
  // Four within six minutes: past what any width lays out side by side.
  on(event('bottle', LATER, [8, 0], null, { value: 90 })),
  on(event('diaper', LATER, [8, 2])),
  on(event('bottle', LATER, [8, 4], null, { value: 110 })),
  on(event('nursing', LATER, [8, 6], [LATER, 8, 19])),
  on(event('milestone', LATER, [0, 0], null, { metadata: { title: 'rolled over' } })),
  on(event('weight', LATER, [10, 15], null, { value: 7820 })),
  on(event('bottle', LATER, [15, 32], null, { value: 198 })),
  on(event('solid_food', LATER, [16, 27])),
  on(event('walk', LATER, [16, 44], [LATER, 17, 10])),
  on(event('diaper', LATER, [17, 6])),
  // The long one. Five hours and forty-seven minutes of bar, and the bar is
  // the only thing that says so.
  on(event('nursing', LATER, [17, 24], [LATER, 23, 11])),
  on(event('diaper', LATER, [17, 24])),
  on(stopped),
];

/** Written up with no signal, and still on the device (spec 6.1). */
export const QUEUED: QueuedCreate[] = [{
  scope: 'preview',
  userId: 'parent',
  babyId: 'baby',
  eventId: 'preview-queued',
  input: {
    typeId: 'bottle',
    intent: 'record',
    startedAt: at(LATER, 12, 10),
    endedAt: null,
    value: 160,
    note: '',
    metadata: {},
  },
  outcomeUnknown: false,
  attempts: 0,
  nextAttemptAt: 0,
  state: 'queued',
  lastCode: null,
  queuedAt: 0,
}];

/** Stopped here at 22:30; the server still has the timer running (spec 7.2). */
export const DRAFTS: StopDraft[] = [{
  scope: 'preview',
  eventId: stopped.id,
  endedAt: at(LATER, 22, 30),
  version: 3,
  createdAt: 0,
}];
