import { describe, expect, it } from 'vitest';
import { fixturePlan } from '../stats-fixture.mjs';

/**
 * Whether the statistics fixture holds a whole year.
 *
 * The failure this exists for is quiet. The insert goes in chunks, so a run
 * that died partway leaves a few hundred events in the table; the first
 * version of the script then saw a non-zero count on the next run, skipped
 * filling, and printed timings for a fortnight of data as though they were a
 * year's. Nothing errored, and the numbers looked reassuring.
 */

const YEAR = {
  existing: 4453,
  expected: 4453,
  firstDate: '2025-09-25',
  lastDate: '2026-09-24',
  wantFirst: '2025-09-25',
  wantLast: '2026-09-24',
};

describe('deciding what to do with what is already there', () => {
  it('fills an empty database', () => {
    expect(fixturePlan({ ...YEAR, existing: 0 }).action).toBe('fill');
  });

  it('keeps a complete year', () => {
    expect(fixturePlan(YEAR).action).toBe('keep');
  });

  it('rebuilds after a run that stopped between chunks', () => {
    // The exact case: the first 500 rows landed and the rest did not.
    const plan = fixturePlan({ ...YEAR, existing: 500, lastDate: '2025-10-15' });
    expect(plan.action).toBe('rebuild');
    expect(plan.why).toContain('500');
  });

  it('rebuilds when there are more rows than a year should have', () => {
    // Two interrupted runs, the second of which filled in again.
    expect(fixturePlan({ ...YEAR, existing: 4953 }).action).toBe('rebuild');
  });

  it('rebuilds when the year has moved on', () => {
    // The window ends yesterday, so a fixture built last week covers days
    // that are no longer the year being asked about -- and a measurement
    // over a range whose ends are missing is a measurement of less data.
    expect(fixturePlan({ ...YEAR, wantFirst: '2025-10-02', wantLast: '2026-10-01' }).action)
      .toBe('rebuild');
  });

  it('does not mistake a complete year for a moved one', () => {
    expect(fixturePlan({ ...YEAR }).why).toContain('whole year');
  });
});
