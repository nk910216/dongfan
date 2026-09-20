/**
 * ============================================================
 *  MOCK DATA — UI PROTOTYPE ONLY
 * ============================================================
 *
 * Everything in this file is invented. It exists so the screens can be
 * reviewed before the API exists, and it must be gone before M1 is called
 * complete: the acceptance criteria require the app to run against a real
 * local D1 (spec 12.1).
 *
 * The UI shows a visible banner while this module is in use, so a mocked
 * screen can never be mistaken for a working one.
 *
 * Nothing here is real family data.
 */

import type { EventIntent } from '@dongfan/shared';

export const IS_MOCK_DATA = true;

export type MockBaby = {
  id: string;
  nickname: string;
  birthDate: string;
  timezone: string;
};

export type MockEvent = {
  id: string;
  typeId: string;
  startedAt: number;
  endedAt: number | null;
  /** Mirrors the `active` column: only a running timer sets it (spec 3.5). */
  active: boolean;
  value: number;
  note: string;
  metadata: Record<string, string>;
  intent: EventIntent;
};

export const MOCK_BABY: MockBaby = {
  id: 'baby-mock',
  nickname: '小葉',
  birthDate: '2026-03-08',
  timezone: 'Asia/Taipei',
};

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Anchored to now so the relative times in the UI stay believable. */
function buildEvents(now: number): MockEvent[] {
  const event = (
    typeId: string,
    minutesAgo: number,
    extra: Partial<MockEvent> = {},
  ): MockEvent => ({
    id: `mock-${typeId}-${minutesAgo}`,
    typeId,
    startedAt: now - minutesAgo * MINUTE,
    endedAt: null,
    active: false,
    value: 1,
    note: '',
    metadata: {},
    intent: 'record',
    ...extra,
  });

  return [
    // A running sleep timer, so the home screen shows the live state.
    event('sleep', 83, { active: true, intent: 'start_timer' }),
    event('diaper', 32, { metadata: { diaper_kind: 'pee' }, endedAt: now - 32 * MINUTE }),
    event('nursing', 72, {
      endedAt: now - 53 * MINUTE,
      metadata: { side: 'both' },
    }),
    event('bottle', 190, { value: 140, endedAt: now - 190 * MINUTE }),
    event('bottle', 400, { value: 160, endedAt: now - 400 * MINUTE }),
    event('bottle', 620, { value: 120, endedAt: now - 620 * MINUTE }),
    event('diaper', 240, { metadata: { diaper_kind: 'poo' }, endedAt: now - 240 * MINUTE }),
    event('diaper', 410, { metadata: {}, endedAt: now - 410 * MINUTE }),
    event('diaper', 500, { metadata: {}, endedAt: now - 500 * MINUTE }),
    event('weight', 9 * 60, { value: 7420, endedAt: now - 9 * HOUR }),
    event('solid_food', 10 * 60, {
      metadata: { food_name: '南瓜泥' },
      endedAt: now - 10 * HOUR,
    }),
    event('milestone', 11 * 60, {
      metadata: { title: '第一次翻身' },
      endedAt: now - 11 * HOUR,
    }),
    event('height', 30 * 60, { value: 682, endedAt: now - 30 * HOUR }),
  ];
}

export const MOCK_EVENTS: MockEvent[] = buildEvents(Date.now());
