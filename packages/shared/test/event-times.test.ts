import { describe, expect, it } from 'vitest';
import { deriveEventTimes } from '../src/event-times.js';
import { getEventType } from '../src/event-types.js';
import { localToUtc, toLocalDate } from '../src/datetime.js';

const TAIPEI = 'Asia/Taipei';
const at = localToUtc({ year: 2026, month: 9, day: 20, hour: 15, minute: 42 }, TAIPEI);

const type = (id: string) => getEventType(id)!;

describe('deriveEventTimes', () => {
  it('leaves a started timer open and takes the active slot', () => {
    expect(deriveEventTimes(type('sleep'), at, 'start_timer', TAIPEI)).toEqual({
      startedAt: at,
      endedAt: null,
      active: true,
    });
  });

  it('does not invent an end time for a back-filled range', () => {
    // Writing `now` here would record a zero-length sleep nobody measured.
    const times = deriveEventTimes(type('sleep'), at, 'record', TAIPEI);
    expect(times.endedAt).toBeNull();
    expect(times.active).toBe(false);
  });

  it('gives a type without a range no end time at all', () => {
    for (const id of ['bottle', 'diaper', 'weight']) {
      expect(deriveEventTimes(type(id), at, 'record', TAIPEI).endedAt).toBeNull();
    }
  });

  it('never marks a non-timer type active, even when asked to start one', () => {
    expect(deriveEventTimes(type('bottle'), at, 'start_timer', TAIPEI).active).toBe(false);
  });

  it('pins an all-day event to local midnight', () => {
    const times = deriveEventTimes(type('milestone'), at, 'record', TAIPEI);
    expect(times.startedAt).toBe(localToUtc({ year: 2026, month: 9, day: 20 }, TAIPEI));
    expect(toLocalDate(times.startedAt, TAIPEI)).toBe('2026-09-20');
    expect(times.endedAt).toBeNull();
  });

  it('keeps an all-day event on the right day when entered near midnight', () => {
    // 23:50 local: normalising with the device timezone would land on the
    // wrong calendar day for a baby in a different zone.
    const lateNight = localToUtc({ year: 2026, month: 9, day: 20, hour: 23, minute: 50 }, TAIPEI);
    const times = deriveEventTimes(type('milestone'), lateNight, 'record', TAIPEI);
    expect(toLocalDate(times.startedAt, TAIPEI)).toBe('2026-09-20');
  });
});
