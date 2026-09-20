import { describe, expect, it } from 'vitest';
import { formatValue, isWithinRange, toDisplayed, toStored } from '../src/value.js';
import { getEventType } from '../src/event-types.js';

const temperature = getEventType('temperature')!.value!;
const bottle = getEventType('bottle')!.value!;

describe('value scaling', () => {
  it('stores 36.5 degrees as the integer 365', () => {
    expect(toStored(36.5, temperature)).toBe(365);
    expect(Number.isInteger(toStored(36.5, temperature))).toBe(true);
  });

  it('reads 365 back as 36.5', () => {
    expect(toDisplayed(365, temperature)).toBe(36.5);
  });

  it('leaves a scale of one untouched', () => {
    expect(toStored(140, bottle)).toBe(140);
  });

  it('formats with the decimals the scale implies', () => {
    expect(formatValue(365, temperature)).toBe('36.5');
    expect(formatValue(140, bottle)).toBe('140');
  });

  it('survives a round-trip without float drift', () => {
    for (const displayed of [34, 36.1, 36.7, 37.2, 38.9, 42]) {
      expect(toDisplayed(toStored(displayed, temperature), temperature)).toBeCloseTo(displayed, 10);
    }
  });

  it('checks range against displayed units, not stored ones', () => {
    expect(isWithinRange(36.5, temperature)).toBe(true);
    expect(isWithinRange(43, temperature)).toBe(false);
    expect(isWithinRange(365, temperature)).toBe(false);
  });
});
