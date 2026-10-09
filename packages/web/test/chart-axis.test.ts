import { describe, expect, it } from 'vitest';
import { getEventType } from '@dongfan/shared';
import type { ValueSpec } from '@dongfan/shared';
import { axisFor, mayLift, niceStep } from '../src/lib/chart-axis.js';

/**
 * The statistics chart's value axis (spec 7.7).
 *
 * Every case names a real type from the config, so a unit or scale changing
 * there shows up here as a different axis rather than going unnoticed.
 */

function spec(typeId: string): ValueSpec {
  const value = getEventType(typeId)?.value;
  if (!value) throw new Error(`${typeId} has no value spec`);
  return value;
}

const labels = (axis: ReturnType<typeof axisFor>): string[] => axis.ticks.map((tick) => axis.label(tick));

describe('the value axis', () => {
  it('counts in whole times', () => {
    const axis = axisFor('count', null, 7);
    expect(axis.unit).toEqual({ kind: 'times' });
    expect(labels(axis)).toEqual(['0', '2', '4', '6', '8']);
  });

  it('never ticks a count in halves', () => {
    // "2.5 times" is not something that happens.
    expect(labels(axisFor('count', null, 3))).toEqual(['0', '1', '2', '3']);
    expect(niceStep(9, true)).toBe(3);
  });

  it('gives an empty chart an axis to sit on', () => {
    const axis = axisFor('count', null, 0);
    expect(axis.ticks).toEqual([0, 1]);
    expect(axis.top).toBe(1);
  });

  it('reads a bottle in its own unit', () => {
    const axis = axisFor('sum', spec('bottle'), 830);
    expect(axis.unit).toEqual({ kind: 'symbol', symbol: 'ml' });
    expect(labels(axis)).toEqual(['0', '250', '500', '750', '1000']);
  });

  it('reads a weight in grams', () => {
    expect(labels(axisFor('last', spec('weight'), 7420))).toEqual(['0', '2000', '4000', '6000', '8000']);
  });

  it('ticks a temperature in degrees, not in the tenths it is stored in', () => {
    // 385 stored is 38.5. Ticked in stored units the axis would say 400.
    const axis = axisFor('max', spec('temperature'), 385);
    // Spec 3.1's symbol, which the config had as a bare "C".
    expect(axis.unit).toEqual({ kind: 'symbol', symbol: '°C' });
    expect(labels(axis)).toEqual(['0', '10', '20', '30', '40']);
    expect(axis.top).toBe(400);
  });

  it('reads a short duration in minutes and a long one in hours', () => {
    const short = axisFor('duration_sum', null, 90);
    expect(short.unit).toEqual({ kind: 'minutes' });
    expect(labels(short)).toEqual(['0', '25', '50', '75', '100']);

    const night = axisFor('duration_sum', null, 480);
    expect(night.unit).toEqual({ kind: 'hours' });
    expect(labels(night)).toEqual(['0', '2', '4', '6', '8']);
    // Placed in the minutes the series is in.
    expect(night.ticks).toEqual([0, 120, 240, 360, 480]);
  });

  it('prints a fractional step without trailing zeros', () => {
    expect(labels(axisFor('duration_sum', null, 120))).toEqual(['0', '0.5', '1', '1.5', '2']);
  });

  it('always reaches the highest value, so no bar runs off the top', () => {
    for (const highest of [1, 7, 99, 101, 333, 999, 1001, 7420, 29999]) {
      expect(axisFor('sum', spec('bottle'), highest).top).toBeGreaterThanOrEqual(highest);
      expect(axisFor('count', null, highest).top).toBeGreaterThanOrEqual(highest);
      expect(axisFor('duration_sum', null, highest).top).toBeGreaterThanOrEqual(highest);
    }
  });
});

describe('a line of readings, which may start above zero', () => {
  it('is only a line, and only of readings', () => {
    // A bar's length is its value, and a count or a total has a real zero.
    expect(mayLift('last', spec('weight'), 'line')).toBe(true);
    expect(mayLift('max', spec('temperature'), 'line')).toBe(true);
    expect(mayLift('last', spec('weight'), 'bar')).toBe(false);
    expect(mayLift('sum', spec('bottle'), 'line')).toBe(false);
    expect(mayLift('count', null, 'line')).toBe(false);
    expect(mayLift('duration_sum', null, 'line')).toBe(false);
  });

  it('scales a weight to its readings rather than to zero', () => {
    // From zero, 7000 g to 7400 g is a flat line.
    const axis = axisFor('last', spec('weight'), 7400, { lowest: 7000 });
    expect(labels(axis)).toEqual(['7000', '7100', '7200', '7300', '7400']);
    expect(axis.bottom).toBe(7000);
  });

  it('scales a fever to degrees around it', () => {
    const axis = axisFor('max', spec('temperature'), 385, { lowest: 365 });
    expect(labels(axis)).toEqual(['36.5', '37', '37.5', '38', '38.5']);
    expect(axis.bottom).toBe(365);
  });

  it('gives a single reading room either side', () => {
    const axis = axisFor('last', spec('weight'), 7420, { lowest: 7420 });
    expect(axis.bottom).toBeLessThanOrEqual(7420);
    expect(axis.top).toBeGreaterThan(7420);
    expect(axis.bottom).toBeGreaterThan(0);
  });

  it('always holds every reading between its ends', () => {
    for (const [lowest, highest] of [[6810, 7420], [355, 362], [1, 9], [4990, 5010], [700, 7000]]) {
      const axis = axisFor('last', spec('weight'), highest as number, { lowest: lowest as number });
      expect(axis.bottom).toBeLessThanOrEqual(lowest as number);
      expect(axis.top).toBeGreaterThanOrEqual(highest as number);
    }
  });

  it('starts at zero when nothing asks it to lift', () => {
    expect(axisFor('last', spec('weight'), 7400).bottom).toBe(0);
  });
});
