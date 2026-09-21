import { describe, expect, it } from 'vitest';
import { getDraft, keepDraft, listDrafts, removeDraft, scopeOf } from '../src/lib/db.js';
import type { StopDraft } from '../src/lib/db.js';

/**
 * The record of when a timer was actually stopped.
 *
 * Its whole value is one number: the instant a parent pressed the button
 * with no signal. Everything here is about that number surviving --
 * somebody pressing again because nothing appeared to happen, a second
 * account using the same phone, the event being dealt with some other way.
 * Lose it and the sleep is recorded however long it took the connection to
 * come back, which is the failure spec 7.2 exists to prevent.
 */

const USER = 'user-1';
const BABY = 'baby-1';
const SCOPE = scopeOf(USER, BABY);
const AT_0310 = 1_789_000_000_000;

function draft(overrides: Partial<StopDraft> = {}): StopDraft {
  return {
    scope: SCOPE,
    eventId: 'sleep-1',
    endedAt: AT_0310,
    version: 3,
    createdAt: AT_0310,
    ...overrides,
  };
}

describe('writing down when a timer was stopped', () => {
  it('keeps the moment the button was pressed', async () => {
    await keepDraft(draft());
    expect((await getDraft(SCOPE, 'sleep-1'))?.endedAt).toBe(AT_0310);
  });

  it('does not move it when the button is pressed again', async () => {
    await keepDraft(draft());
    // Nothing visibly happened, so five minutes later they press again.
    // Recording that press instead would make the sleep five minutes
    // longer than it was, which is the error this whole thing exists to
    // avoid (spec 7.2).
    await keepDraft(draft({ endedAt: AT_0310 + 5 * 60_000, createdAt: AT_0310 + 5 * 60_000 }));

    expect((await getDraft(SCOPE, 'sleep-1'))?.endedAt).toBe(AT_0310);
    expect(await listDrafts(SCOPE)).toHaveLength(1);
  });

  it('hands back what is actually stored, not what it was given', async () => {
    await keepDraft(draft());
    const second = await keepDraft(draft({ endedAt: AT_0310 + 60_000 }));

    // A caller that showed the time it just passed in would put a moment
    // on screen that is not the one which will be sent.
    expect(second.endedAt).toBe(AT_0310);
  });

  it('remembers the version the event had, for the confirmation to compare', async () => {
    await keepDraft(draft({ version: 3 }));
    expect((await getDraft(SCOPE, 'sleep-1'))?.version).toBe(3);
  });
});

describe('keeping one family out of another’s', () => {
  it('shows a scope only its own drafts', async () => {
    const other = scopeOf('other-parent', 'other-baby');
    await keepDraft(draft());
    await keepDraft(draft({ scope: other, eventId: 'theirs' }));

    expect((await listDrafts(SCOPE)).map((row) => row.eventId)).toEqual(['sleep-1']);
    expect((await listDrafts(other)).map((row) => row.eventId)).toEqual(['theirs']);
  });

  it('will not find another scope’s draft by id', async () => {
    await keepDraft(draft({ scope: scopeOf('other-parent', 'other-baby') }));
    expect(await getDraft(SCOPE, 'sleep-1')).toBeNull();
  });

  it('lets the same event be drafted under two accounts on one phone', async () => {
    const other = scopeOf('other-parent', BABY);
    await keepDraft(draft({ endedAt: AT_0310 }));
    await keepDraft(draft({ scope: other, endedAt: AT_0310 + 60_000 }));

    expect((await getDraft(SCOPE, 'sleep-1'))?.endedAt).toBe(AT_0310);
    expect((await getDraft(other, 'sleep-1'))?.endedAt).toBe(AT_0310 + 60_000);
  });
});

describe('throwing one away', () => {
  it('removes the one named and no other', async () => {
    await keepDraft(draft({ eventId: 'sleep-1' }));
    await keepDraft(draft({ eventId: 'walk-1', createdAt: AT_0310 + 1 }));

    await removeDraft(SCOPE, 'sleep-1');

    expect((await listDrafts(SCOPE)).map((row) => row.eventId)).toEqual(['walk-1']);
  });

  it('leaves another account’s alone', async () => {
    const other = scopeOf('other-parent', BABY);
    await keepDraft(draft());
    await keepDraft(draft({ scope: other }));

    await removeDraft(SCOPE, 'sleep-1');

    expect(await getDraft(other, 'sleep-1')).not.toBeNull();
  });

  it('is oldest first, so the screen offers them in the order they happened', async () => {
    await keepDraft(draft({ eventId: 'second', createdAt: AT_0310 + 1000 }));
    await keepDraft(draft({ eventId: 'first', createdAt: AT_0310 }));

    expect((await listDrafts(SCOPE)).map((row) => row.eventId)).toEqual(['first', 'second']);
  });
});
