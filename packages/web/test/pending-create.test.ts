import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetPending, pendingFor, pendingList, rememberPending,
} from '../src/lib/pending-create.js';
import type { PendingCreate } from '../src/lib/pending-create.js';

/**
 * The store that holds adds whose result nobody knows.
 *
 * Tested as plain functions because that is what they are, and because the
 * rule they enforce is a single sentence with no exceptions: nothing an
 * entry does not name may remove it. Every bug here so far has been a new
 * way of breaking that sentence -- one shared slot, an unconditional
 * clear, and then a cap that dropped the oldest to make room.
 */

const USER = 'user-1';
const BABY = 'baby-1';

function entry(eventId: string, typeId = 'bottle', userId = USER, babyId = BABY): PendingCreate {
  return {
    userId,
    babyId,
    eventId,
    input: {
      typeId,
      intent: 'record',
      startedAt: 1_789_000_000_000,
      endedAt: null,
      value: 150,
      note: '',
      metadata: {},
    },
  };
}

beforeEach(() => localStorage.clear());

describe('keeping entries', () => {
  it('holds each one under its own id', () => {
    rememberPending(entry('a'));
    rememberPending(entry('b', 'diaper'));

    expect(pendingList(USER, BABY).map((e) => e.eventId)).toEqual(['a', 'b']);
  });

  it('replaces an entry only with itself', () => {
    rememberPending(entry('a'));
    const corrected = entry('a');
    rememberPending({ ...corrected, input: { ...corrected.input, value: 200 } });

    const list = pendingList(USER, BABY);
    expect(list).toHaveLength(1);
    expect(list[0]?.input.value).toBe(200);
  });

  it('never drops an older entry to make room for a newer one', () => {
    // A cap that trims the oldest is the same bug as one shared slot: the
    // id it throws away is the only thing keeping a retry from writing the
    // record a second time.
    for (let n = 0; n < 40; n += 1) rememberPending(entry(`event-${n}`));

    const list = pendingList(USER, BABY);
    expect(list).toHaveLength(40);
    expect(list[0]?.eventId).toBe('event-0');
    expect(pendingFor(USER, BABY, 'bottle')?.eventId).toBe('event-0');
  });
});

describe('removing entries', () => {
  it('removes the one named and no other', () => {
    rememberPending(entry('a'));
    rememberPending(entry('b', 'diaper'));

    forgetPending(USER, BABY, 'b');

    expect(pendingList(USER, BABY).map((e) => e.eventId)).toEqual(['a']);
  });

  it('ignores a request from a different account', () => {
    rememberPending(entry('a'));
    forgetPending('somebody-else', BABY, 'a');

    expect(pendingList(USER, BABY)).toHaveLength(1);
  });

  it('ignores a request naming a different baby', () => {
    rememberPending(entry('a'));
    forgetPending(USER, 'another-baby', 'a');

    expect(pendingList(USER, BABY)).toHaveLength(1);
  });
});

describe('reading entries back', () => {
  it('keeps one account out of another’s', () => {
    rememberPending(entry('mine'));
    rememberPending(entry('theirs', 'bottle', 'the-other-parent'));

    expect(pendingList(USER, BABY).map((e) => e.eventId)).toEqual(['mine']);
    expect(pendingFor(USER, BABY, 'bottle')?.eventId).toBe('mine');
  });

  it('keeps one baby out of another’s', () => {
    rememberPending(entry('sibling', 'bottle', USER, 'baby-2'));

    expect(pendingList(USER, BABY)).toEqual([]);
  });

  it('offers a type only its own entries', () => {
    rememberPending(entry('a', 'diaper'));

    // Resending a nappy because somebody opened the bottle form would be
    // worse than the duplicate all of this exists to prevent.
    expect(pendingFor(USER, BABY, 'bottle')).toBeNull();
    expect(pendingFor(USER, BABY, 'diaper')?.eventId).toBe('a');
  });

  it('survives a corrupt or half-written store', () => {
    localStorage.setItem('dongfan.pending-creates', '{"not":"an array"}');
    expect(pendingList(USER, BABY)).toEqual([]);

    localStorage.setItem('dongfan.pending-creates', 'not json at all');
    expect(pendingList(USER, BABY)).toEqual([]);
  });

  it('drops entries that are not shaped like one', () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([entry('good'), { eventId: 'bad' }]));
    expect(pendingList(USER, BABY).map((e) => e.eventId)).toEqual(['good']);
  });
});
