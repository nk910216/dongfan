import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_HASH, MIN_PASSWORD_LENGTH, PBKDF2_ITERATIONS,
  SUPPORTED_TIMEZONES, isPasswordLongEnough,
} from '../src/index.js';
import { EARLIEST_BIRTH_DATE, isPlausibleBirthDate, isRealLocalDate, localToUtc } from '../src/datetime.js';
import { USER_CONTENT } from './fixtures/user-content.js';

const TAIPEI = 'Asia/Taipei';
const now = localToUtc({ year: 2026, month: 9, day: 20, hour: 12 }, TAIPEI);

describe('isRealLocalDate', () => {
  it('accepts a real day', () => {
    expect(isRealLocalDate('2026-09-20')).toBe(true);
    expect(isRealLocalDate('2028-02-29')).toBe(true);
  });

  it('rejects days that match the pattern but do not exist', () => {
    // These are the ones a regex alone lets through.
    for (const value of ['2026-02-30', '2026-02-31', '2026-04-31', '2027-02-29']) {
      expect(isRealLocalDate(value), value).toBe(false);
    }
  });

  it('rejects out-of-range months and days', () => {
    for (const value of ['2026-13-01', '2026-00-10', '2026-09-00', '2026-09-32']) {
      expect(isRealLocalDate(value), value).toBe(false);
    }
  });

  it('rejects anything that is not the expected shape', () => {
    for (const value of ['2026-9-20', '20260920', '', 'today', String(Date.now())]) {
      expect(isRealLocalDate(value), value).toBe(false);
    }
  });
});

describe('isPlausibleBirthDate', () => {
  it('accepts a date in the past', () => {
    expect(isPlausibleBirthDate('2026-03-08', now, TAIPEI)).toBe(true);
  });

  it('accepts today and tomorrow', () => {
    // Tomorrow is allowed so a boundary entry from another timezone is not
    // refused for a child who has just been born.
    expect(isPlausibleBirthDate('2026-09-20', now, TAIPEI)).toBe(true);
    expect(isPlausibleBirthDate('2026-09-21', now, TAIPEI)).toBe(true);
  });

  it('rejects a date further ahead than that', () => {
    expect(isPlausibleBirthDate('2026-09-22', now, TAIPEI)).toBe(false);
    expect(isPlausibleBirthDate('2030-01-01', now, TAIPEI)).toBe(false);
  });

  it('rejects a date old enough to be a typo', () => {
    expect(isPlausibleBirthDate(EARLIEST_BIRTH_DATE, now, TAIPEI)).toBe(true);
    expect(isPlausibleBirthDate('1899-12-31', now, TAIPEI)).toBe(false);
  });

  it('rejects an impossible day even when the range is fine', () => {
    expect(isPlausibleBirthDate('2026-02-31', now, TAIPEI)).toBe(false);
  });
});

describe('password rules', () => {
  it('requires the documented length', () => {
    expect(isPasswordLongEnough('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isPasswordLongEnough('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
  });

  it('counts characters rather than bytes', () => {
    // Twenty characters is twenty characters whatever the encoding costs.
    const twenty = USER_CONTENT.multiByteCharacter.repeat(MIN_PASSWORD_LENGTH);
    expect(new TextEncoder().encode(twenty).length).toBeGreaterThan(MIN_PASSWORD_LENGTH);
    expect(isPasswordLongEnough(twenty)).toBe(true);
  });
});

describe('placeholder hash for unknown accounts', () => {
  it('carries the real iteration count', () => {
    // A cheaper placeholder would answer far sooner for an unknown username
    // than for a wrong password, making account existence measurable.
    expect(DUMMY_PASSWORD_HASH.split('$')[2]).toBe(String(PBKDF2_ITERATIONS));
  });

  it('has the same shape a stored hash does', () => {
    const parts = DUMMY_PASSWORD_HASH.split('$');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('sha256');
  });
});

describe('supported timezones', () => {
  it('is limited to zones without daylight saving in v1', () => {
    // The "at most one midnight crossing" premise depends on this.
    expect(SUPPORTED_TIMEZONES).toEqual(['Asia/Taipei']);
  });
});
