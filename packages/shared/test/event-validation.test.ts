import { describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DURATION_MS, MAX_NOTE_LENGTH,
  getEventType, resolveEventTimes, startOfLocalDay, toLocalDate, validateEvent,
} from '../src/index.js';
import type { EventTypeConfig, EventValidationInput } from '../src/index.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * The rules an event has to satisfy, as pure functions.
 *
 * This is the layer worth chasing coverage in: every branch here decides
 * whether something a parent typed is stored correctly or quietly reshaped
 * (spec 11.1).
 */

const TZ = 'Asia/Taipei';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-20T06:00:00Z');
const CTX = { now: NOW, timeZone: TZ, birthDate: '2026-03-08' };

function type(id: string): EventTypeConfig {
  const found = getEventType(id);
  if (!found) throw new Error(`No such type: ${id}`);
  return found;
}

function check(typeId: string, input: Partial<EventValidationInput>): string[] {
  return validateEvent(
    type(typeId),
    { intent: 'record', startedAt: NOW, endedAt: null, ...input },
    CTX,
  ).map((error) => `${error.field}:${error.code}`);
}

describe('times', () => {
  it('accepts an ordinary moment today', () => {
    expect(check('bottle', { value: 120 })).toEqual([]);
  });

  it('allows a day of clock skew but not three', () => {
    expect(check('bottle', { value: 120, startedAt: NOW + 20 * HOUR })).toEqual([]);
    expect(check('bottle', { value: 120, startedAt: NOW + 3 * 24 * HOUR }))
      .toEqual(['startedAt:TOO_FAR_IN_FUTURE']);
  });

  it('allows the day before the birth date but not the month before', () => {
    const dayBefore = startOfLocalDay('2026-03-07', TZ) + 12 * HOUR;
    expect(check('bottle', { value: 120, startedAt: dayBefore })).toEqual([]);

    const weekBefore = startOfLocalDay('2026-03-01', TZ);
    expect(check('bottle', { value: 120, startedAt: weekBefore })).toEqual(['startedAt:BEFORE_BIRTH']);
  });

  it('judges the future by the baby timezone, not by UTC', () => {
    // Eleven at night in Taipei is still the same day there; read as UTC it
    // would be tomorrow afternoon and look a day further ahead than it is.
    const tonight = startOfLocalDay(toLocalDate(NOW, TZ), TZ) + 23 * HOUR;
    expect(check('bottle', { value: 120, startedAt: tonight })).toEqual([]);
  });

  it('refuses an end before the start', () => {
    expect(check('sleep', { startedAt: NOW, endedAt: NOW - HOUR })).toEqual(['endedAt:END_BEFORE_START']);
  });

  it('draws the line at exactly a day', () => {
    expect(check('sleep', { startedAt: NOW - 24 * HOUR, endedAt: NOW })).toEqual([]);
    expect(check('sleep', { startedAt: NOW - 24 * HOUR - 1, endedAt: NOW }))
      .toEqual(['endedAt:DURATION_TOO_LONG']);
  });

  it('reports the ceiling in hours, because that is how it reads', () => {
    const errors = validateEvent(
      type('sleep'),
      { intent: 'record', startedAt: NOW - 30 * HOUR, endedAt: NOW },
      CTX,
    );
    expect(errors[0]?.params).toEqual({ maxHours: MAX_EVENT_DURATION_MS / HOUR });
  });

  it('refuses an end time on a type that has no range', () => {
    expect(check('bottle', { value: 120, endedAt: NOW })).toEqual(['endedAt:UNKNOWN_FIELD']);
  });

  it('refuses an end time on something being started right now', () => {
    expect(check('sleep', { intent: 'start_timer', endedAt: NOW + HOUR })).toEqual(['endedAt:UNKNOWN_FIELD']);
  });
});

describe('intent', () => {
  it('refuses to start a timer on a type without one', () => {
    expect(check('bottle', { intent: 'start_timer', value: 120 })).toEqual(['intent:INVALID_ENUM']);
  });

  it('allows a timer type to be back-filled instead', () => {
    expect(check('sleep', { intent: 'record', startedAt: NOW - 2 * HOUR, endedAt: NOW })).toEqual([]);
  });
});

describe('values', () => {
  it('requires one where the type says so', () => {
    expect(check('bottle', {})).toEqual(['value:REQUIRED']);
  });

  it('does not require one where the type does not', () => {
    expect(check('solid_food', { metadata: { food_name: USER_CONTENT.nickname } })).toEqual([]);
  });

  it('judges the range in displayed units', () => {
    // 36.5 degrees is stored as 365, and the bounds are 34 to 42.
    expect(check('temperature', { value: 365 })).toEqual([]);
    expect(check('temperature', { value: 430 })).toEqual(['value:OUT_OF_RANGE']);
  });

  it('keeps one millilitre, which is a real amount and not a sentinel', () => {
    expect(check('bottle', { value: 1 })).toEqual([]);
  });

  it('refuses a fraction of the smallest unit', () => {
    expect(check('bottle', { value: 12.5 })).toEqual(['value:NOT_INTEGER']);
  });

  it('refuses an amount on a type that has no quantity', () => {
    expect(check('sleep', { value: 5 })).toEqual(['value:UNKNOWN_FIELD']);
    // The column default is one, so that much is not a client mistake.
    expect(check('sleep', { value: 1 })).toEqual([]);
  });
});

describe('metadata', () => {
  it('refuses a key the config does not define', () => {
    expect(check('diaper', { metadata: { colour: 'green' } })).toEqual(['metadata.colour:UNKNOWN_FIELD']);
  });

  it('refuses a value outside the enum', () => {
    expect(check('diaper', { metadata: { diaper_kind: 'sideways' } }))
      .toEqual(['metadata.diaper_kind:INVALID_ENUM']);
  });

  it('treats an optional field left blank as not filled in', () => {
    expect(check('diaper', { metadata: { diaper_kind: '' } })).toEqual([]);
    expect(check('diaper', {})).toEqual([]);
  });

  it('insists on the one field that is required', () => {
    expect(check('milestone', { metadata: {} })).toEqual(['metadata.title:REQUIRED']);
    expect(check('milestone', { metadata: { title: USER_CONTENT.note } })).toEqual([]);
  });

  it('measures text in characters, not in UTF-16 units', () => {
    // fifty astral characters is a hundred units, and the limit is fifty.
    const fifty = USER_CONTENT.astralCharacter.repeat(50);
    expect(check('solid_food', { metadata: { food_name: fifty } })).toEqual([]);
    expect(check('solid_food', { metadata: { food_name: fifty + 'x' } }))
      .toEqual(['metadata.food_name:TOO_LONG']);
  });
});

describe('notes', () => {
  it('accepts a parent’s own words unchanged', () => {
    expect(check('bottle', { value: 120, note: USER_CONTENT.noteWithEmoji })).toEqual([]);
  });

  it('counts the note in characters too', () => {
    const limit = USER_CONTENT.astralCharacter.repeat(MAX_NOTE_LENGTH);
    expect(check('bottle', { value: 120, note: limit })).toEqual([]);
    expect(check('bottle', { value: 120, note: limit + 'x' })).toEqual(['note:TOO_LONG']);
  });
});

describe('resolving the times that get stored', () => {
  it('gives a running timer the active slot and no end', () => {
    const times = resolveEventTimes(type('sleep'), { startedAt: NOW, endedAt: null, intent: 'start_timer' }, TZ);
    expect(times).toEqual({ startedAt: NOW, endedAt: null, active: true });
  });

  it('gives a back-filled record no slot at all', () => {
    const times = resolveEventTimes(
      type('sleep'), { startedAt: NOW - HOUR, endedAt: NOW, intent: 'record' }, TZ,
    );
    expect(times).toEqual({ startedAt: NOW - HOUR, endedAt: NOW, active: false });
  });

  it('pins an all-day event to local midnight whatever hour it was entered', () => {
    const times = resolveEventTimes(type('milestone'), { startedAt: NOW, endedAt: null, intent: 'record' }, TZ);
    expect(times.startedAt).toBe(startOfLocalDay(toLocalDate(NOW, TZ), TZ));
    expect(times.endedAt).toBeNull();
    expect(times.active).toBe(false);
  });

  it('never leaves an end time on a type that has no range', () => {
    const times = resolveEventTimes(type('bottle'), { startedAt: NOW, endedAt: NOW, intent: 'record' }, TZ);
    expect(times.endedAt).toBeNull();
  });
});
