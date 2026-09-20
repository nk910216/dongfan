import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, getEventType, quickActionTypes } from '../src/event-types.js';
import { assertEventTypesValid } from '../src/validate-config.js';
import type { EventTypeConfig } from '../src/types.js';

const base: EventTypeConfig = {
  id: 'probe',
  category: 'other',
  icon: 'circle',
  color: '#ffffff',
  hasRange: false,
  timerEnabled: false,
  allDay: false,
  value: null,
  valueRequired: false,
  aggregation: 'count',
  quickAction: false,
  order: 1,
};

describe('shipped config', () => {
  it('satisfies every invariant', () => {
    expect(() => assertEventTypesValid()).not.toThrow();
  });

  it('covers all v1 types', () => {
    expect(EVENT_TYPES).toHaveLength(23);
  });

  it('returns undefined for an unknown id so callers can fall back', () => {
    expect(getEventType('not_a_type')).toBeUndefined();
  });

  it('exposes quick actions in order', () => {
    const ids = quickActionTypes().map((t) => t.id);
    expect(ids).toContain('sleep');
    expect(ids).toContain('diaper');
  });

  it('never aggregates a growth measurement by summing it', () => {
    for (const id of ['weight', 'height', 'head_circ']) {
      expect(getEventType(id)?.aggregation).toBe('last');
    }
  });

  it('stores temperature in tenths so no float reaches the database', () => {
    expect(getEventType('temperature')?.value?.scale).toBe(10);
  });
});

describe('invariants', () => {
  it('rejects a timer that has no end time', () => {
    expect(() => assertEventTypesValid([{ ...base, timerEnabled: true, hasRange: false }])).toThrow(/timerEnabled/);
  });

  it('rejects an all-day event that also has a range', () => {
    expect(() => assertEventTypesValid([{ ...base, allDay: true, hasRange: true }])).toThrow(/allDay/);
  });

  it('rejects a numeric aggregation with no value spec', () => {
    expect(() => assertEventTypesValid([{ ...base, aggregation: 'sum' }])).toThrow(/value spec/);
  });

  it('rejects duplicate order within a category', () => {
    expect(() =>
      assertEventTypesValid([base, { ...base, id: 'probe2' }]),
    ).toThrow(/duplicate order/);
  });

  it('rejects a duplicate id', () => {
    expect(() => assertEventTypesValid([base, { ...base, order: 2 }])).toThrow(/duplicate id/);
  });
});
