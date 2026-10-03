import { beforeEach, describe, expect, it } from 'vitest';
import type { EventDto } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from '../src/lib/api.js';
import { beginSend, getQueued, listQueued, putQueued, scopeOf } from '../src/lib/db.js';
import type { NewEventInput, QueuedCreate } from '../src/lib/db.js';
import {
  EntryGone, FIRST_DELAY_MS, MAX_ATTEMPTS, MAX_DELAY_MS, afterFailure, attemptQueued,
  correctQueued, delayFor, disposition, migrateLegacyPending, queueAdd, resetMigration,
  retryQueued, runOutbox,
} from '../src/lib/outbox.js';

/**
 * The queue's rules, tested where they live.
 *
 * Every one of these is a sentence from spec 6.1 that fails silently when
 * it is broken: the record still looks saved, the screen still looks
 * healthy, and what is missing only shows up weeks later when somebody
 * goes looking for a feed that was written down at three in the morning.
 */

const USER = 'user-1';
const BABY = 'baby-1';
const SCOPE = scopeOf(USER, BABY);
const NOW = 1_789_000_000_000;

function input(overrides: Partial<NewEventInput> = {}): NewEventInput {
  return {
    typeId: 'bottle',
    intent: 'record',
    startedAt: NOW,
    endedAt: null,
    value: 150,
    tagIds: [],
    note: '',
    metadata: {},
    ...overrides,
  };
}

function entry(overrides: Partial<QueuedCreate> = {}): QueuedCreate {
  return {
    scope: SCOPE,
    userId: USER,
    babyId: BABY,
    eventId: 'event-1',
    input: input(),
    outcomeUnknown: false,
    attempts: 0,
    nextAttemptAt: NOW,
    state: 'queued',
    lastCode: null,
    queuedAt: NOW,
    ...overrides,
  };
}

function stored(eventId: string): EventDto {
  return {
    id: eventId,
    babyId: BABY,
    typeId: 'bottle',
    createdBy: USER,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    endedAt: null,
    localDate: '2026-09-21',
    value: 150,
    note: '',
    metadata: {},
    version: 1,
    rev: 7,
    active: false,
    deletedAt: null,
    tagIds: [],
  };
}

const network = (): NetworkFailure => new NetworkFailure(new Error('gone'));
const refused = (status: number, code: string): ApiFailure => new ApiFailure(status, code);

beforeEach(() => {
  resetMigration();
  localStorage.clear();
});

describe('how long to wait', () => {
  it('starts at five seconds and doubles', () => {
    expect(delayFor(1)).toBe(FIRST_DELAY_MS);
    expect(delayFor(2)).toBe(2 * FIRST_DELAY_MS);
    expect(delayFor(3)).toBe(4 * FIRST_DELAY_MS);
  });

  it('never waits longer than five minutes', () => {
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      expect(delayFor(attempt)).toBeLessThanOrEqual(MAX_DELAY_MS);
    }
    expect(delayFor(20)).toBe(MAX_DELAY_MS);
  });
});

describe('what an answer means for the queue', () => {
  it.each([
    ['a request that never arrived', network(), 'retry'],
    ['the server falling over', refused(500, 'INTERNAL'), 'retry'],
    ['a session that expired', refused(401, 'UNAUTHENTICATED'), 'pause'],
    ['being asked to slow down', refused(429, 'RATE_LIMITED'), 'wait'],
    ['a body it will never accept', refused(422, 'VALIDATION_FAILED'), 'giveUp'],
    ['no permission', refused(403, 'FORBIDDEN'), 'giveUp'],
    ['the slot already taken', refused(409, 'ACTIVE_TIMER_EXISTS'), 'giveUp'],
    ['the day’s limit', refused(429, 'DAILY_LIMIT_EXCEEDED'), 'wait'],
  ])('reads %s correctly', (_name, error, expected) => {
    expect(disposition(error)).toBe(expected);
  });
});

describe('an attempt that came back badly', () => {
  it('puts the entry in doubt when nothing answered', () => {
    const after = afterFailure(entry(), network(), NOW);
    expect(after.outcomeUnknown).toBe(true);
    expect(after.attempts).toBe(1);
    expect(after.nextAttemptAt).toBe(NOW + FIRST_DELAY_MS);
  });

  it('does not put it in doubt when the server refused it outright', () => {
    const after = afterFailure(entry(), refused(422, 'VALIDATION_FAILED'), NOW);
    expect(after.outcomeUnknown).toBe(false);
    expect(after.state).toBe('failed');
  });

  it.each([
    ['a session that expired', refused(401, 'UNAUTHENTICATED')],
    ['being asked to slow down', refused(429, 'RATE_LIMITED')],
    ['being refused outright', refused(403, 'FORBIDDEN')],
    ['losing access to the baby', refused(404, 'NOT_FOUND')],
    ['a code this build has never met', refused(418, 'SOMETHING_NEW')],
  ])('keeps an existing doubt after %s', (_name, error) => {
    // None of these could only have been said about an event the server
    // does not have, so none of them settles anything (spec 6.1).
    expect(afterFailure(entry({ outcomeUnknown: true }), error, NOW).outcomeUnknown).toBe(true);
  });

  it.each([
    ['VALIDATION_FAILED', refused(422, 'VALIDATION_FAILED')],
    ['DAILY_LIMIT_EXCEEDED', refused(429, 'DAILY_LIMIT_EXCEEDED')],
    ['ACTIVE_TIMER_EXISTS', refused(409, 'ACTIVE_TIMER_EXISTS')],
    ['ID_CONFLICT', refused(409, 'ID_CONFLICT')],
  ])('settles the doubt on %s, which comes after the id was read back', (_name, error) => {
    expect(afterFailure(entry({ outcomeUnknown: true }), error, NOW).outcomeUnknown).toBe(false);
  });

  it('does not spend an attempt on a session that expired', () => {
    const before = entry({ attempts: 3, nextAttemptAt: NOW + 1000 });
    const after = afterFailure(before, refused(401, 'UNAUTHENTICATED'), NOW);
    expect(after.attempts).toBe(3);
    expect(after.nextAttemptAt).toBe(before.nextAttemptAt);
    expect(after.state).toBe('queued');
  });

  it('does not spend an attempt on being rate limited, but still waits', () => {
    const after = afterFailure(entry({ attempts: 3 }), refused(429, 'RATE_LIMITED'), NOW);
    expect(after.attempts).toBe(3);
    expect(after.nextAttemptAt).toBeGreaterThan(NOW);
  });

  it('stops after ten counted attempts rather than retrying for ever', () => {
    let current = entry();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) current = afterFailure(current, network(), NOW);

    expect(current.attempts).toBe(MAX_ATTEMPTS);
    expect(current.state).toBe('failed');
    // The record is still here. It is a parent's own writing, and nothing
    // in the queue is allowed to throw it away (spec 6.1).
    expect(current.input.value).toBe(150);
  });

  it('does not stop early because a rate limit kept arriving', () => {
    let current = entry();
    for (let i = 0; i < 30; i += 1) current = afterFailure(current, refused(429, 'RATE_LIMITED'), NOW);
    expect(current.state).toBe('queued');
  });

  it('remembers what the server said, for the list', () => {
    expect(afterFailure(entry(), refused(403, 'FORBIDDEN'), NOW).lastCode).toBe('FORBIDDEN');
  });
});

describe('the window between a request and its answer', () => {
  /**
   * The server may have the event while this device does not know it. Two
   * things have to be true through that window, and neither was: the
   * record must already be marked as being in doubt, and nothing may
   * change its content (spec 6.1).
   */
  it('marks the record as being in doubt before the request goes out', async () => {
    await queueAdd(USER, BABY, 'event-1', input(), NOW);
    await beginSend(SCOPE, 'event-1');

    // What is on disk at this instant is what a browser killed mid-request
    // would find when it reopened.
    expect((await getQueued(SCOPE, 'event-1'))?.outcomeUnknown).toBe(true);
  });

  it('is already in doubt while the request is in the air', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);
    let duringFlight: QueuedCreate | null = null;

    await attemptQueued(SCOPE, queued, async (id) => {
      duringFlight = await getQueued(SCOPE, 'event-1');
      return stored(id);
    });

    expect(duringFlight).not.toBeNull();
    expect((duringFlight as unknown as QueuedCreate).outcomeUnknown).toBe(true);
  });

  it('refuses a correction made while the request is in the air', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input({ value: 80 }), NOW);
    let refused = false;

    await attemptQueued(SCOPE, queued, async (id) => {
      // 80 ml is on its way. Changing it to 100 here and letting the
      // original response land would leave the server holding 80, the
      // queue empty, and the correction nowhere at all.
      await expect(correctQueued(SCOPE, 'event-1', input({ value: 100 }), NOW)).rejects.toThrow();
      refused = true;
      return stored(id);
    });

    expect(refused).toBe(true);
  });

  it.each([
    ['the send goes first', true],
    ['the correction goes first', false],
  ])('cannot have a correction slip past a send when %s', async (_name, sendFirst) => {
    await queueAdd(USER, BABY, 'event-1', input({ value: 80 }), NOW);

    // Started together, with no await between them, which is how they
    // actually arrive: the queue runs on its own schedule and the screen
    // offering the correction has no way to know a send has just begun.
    const send = (): Promise<QueuedCreate | null> => beginSend(SCOPE, 'event-1');
    const correct = (): Promise<QueuedCreate> =>
      correctQueued(SCOPE, 'event-1', input({ value: 100 }), NOW);

    const [sent, corrected] = sendFirst
      ? await Promise.allSettled([send(), correct()])
      : await Promise.allSettled([correct(), send()]).then(([a, b]) => [b, a] as const);

    const sending = sent.status === 'fulfilled' ? (sent.value as QueuedCreate | null) : null;
    const held = await getQueued(SCOPE, 'event-1');

    // Whichever wins, the two must agree. The failure this guards against
    // is 80 ml on its way to the server while 100 ml sits in the queue:
    // the response to the 80 then removes the entry, and the correction is
    // gone with nothing on screen to say so (spec 6.1).
    expect(sending?.input.value).toBe(held?.input.value);

    if (corrected.status === 'fulfilled') {
      expect(held?.input.value).toBe(100);
    } else {
      expect(held?.input.value).toBe(80);
      expect(held?.outcomeUnknown).toBe(true);
    }
  });

  it('sends what is stored, not the copy the caller was holding', async () => {
    await queueAdd(USER, BABY, 'event-1', input({ value: 150 }), NOW);

    // A caller that read the entry, then waited its turn while somebody
    // corrected it.
    const stale = entry({ input: input({ value: 999 }) });
    let sent: number | undefined;

    await attemptQueued(SCOPE, stale, async (id, payload) => {
      sent = payload.value;
      return stored(id);
    });

    expect(sent).toBe(150);
  });

  it('does not start at all for an entry that has been given up on', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);
    const { abandonQueued } = await import('../src/lib/outbox.js');
    await abandonQueued(SCOPE, 'event-1');

    let attempts = 0;
    const result = await attemptQueued(SCOPE, queued, (id) => {
      attempts += 1;
      return Promise.resolve(stored(id));
    });

    expect(attempts).toBe(0);
    expect(result.ok).toBe(false);
  });
});

describe('sending one entry', () => {
  it('stores the event and takes it out of the queue', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);
    const result = await attemptQueued(SCOPE, queued, async (id) => stored(id));

    expect(result.ok).toBe(true);
    expect(await listQueued(SCOPE)).toHaveLength(0);
  });

  it('keeps it, with the failure recorded, when the server refuses', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);
    await attemptQueued(SCOPE, queued, () => Promise.reject(network()), NOW);

    const after = await getQueued(SCOPE, 'event-1');
    expect(after?.outcomeUnknown).toBe(true);
    expect(after?.attempts).toBe(1);
  });

  it('does not put back an entry that was abandoned while it was in flight', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);

    await attemptQueued(SCOPE, queued, async () => {
      // Somebody pressed "give up" on the list while this was in the air.
      const { abandonQueued } = await import('../src/lib/outbox.js');
      await abandonQueued(SCOPE, 'event-1');
      throw network();
    }, NOW);

    expect(await getQueued(SCOPE, 'event-1')).toBeNull();
  });

  it('never changes the id, however many times it is sent', async () => {
    const queued = await queueAdd(USER, BABY, 'event-1', input(), NOW);
    const ids: string[] = [];
    const send = (id: string): Promise<EventDto> => {
      ids.push(id);
      return Promise.reject(network());
    };

    await attemptQueued(SCOPE, queued, send, NOW);
    const again = await getQueued(SCOPE, 'event-1');
    await attemptQueued(SCOPE, again as QueuedCreate, send, NOW);

    expect(ids).toEqual(['event-1', 'event-1']);
  });
});

describe('working through the queue', () => {
  it('sends in the order the records were made', async () => {
    await queueAdd(USER, BABY, 'second', input(), NOW + 10);
    await queueAdd(USER, BABY, 'first', input(), NOW);

    const sent: string[] = [];
    await runOutbox(SCOPE, async (id) => {
      sent.push(id);
      return stored(id);
    }, () => NOW + 100);

    expect(sent).toEqual(['first', 'second']);
  });

  it('leaves alone anything that is not due yet', async () => {
    await queueAdd(USER, BABY, 'event-1', input(), NOW);
    await putQueued(entry({ eventId: 'event-1', attempts: 1, nextAttemptAt: NOW + FIRST_DELAY_MS }));

    const result = await runOutbox(SCOPE, () => Promise.reject(network()), () => NOW);

    expect(result.sent).toBe(0);
    expect(result.nextDueAt).toBe(NOW + FIRST_DELAY_MS);
  });

  it('does not touch one that has stopped and is waiting for a person', async () => {
    await putQueued(entry({ eventId: 'event-1', state: 'failed' }));

    let attempts = 0;
    await runOutbox(SCOPE, () => {
      attempts += 1;
      return Promise.reject(network());
    }, () => NOW);

    expect(attempts).toBe(0);
  });

  it('stops the whole run when the session has expired', async () => {
    await queueAdd(USER, BABY, 'first', input(), NOW);
    await queueAdd(USER, BABY, 'second', input(), NOW + 1);

    let attempts = 0;
    const result = await runOutbox(SCOPE, () => {
      attempts += 1;
      return Promise.reject(refused(401, 'UNAUTHENTICATED'));
    }, () => NOW + 100);

    // One request, not one per entry: the token is dead and every other
    // attempt would spend a request being told so (spec 6.1).
    expect(attempts).toBe(1);
    expect(result.paused).toBe(true);
    expect((await listQueued(SCOPE)).every((row) => row.state === 'queued')).toBe(true);
  });

  it('will not send another family’s records', async () => {
    const otherScope = scopeOf('other-parent', 'other-baby');
    await queueAdd('other-parent', 'other-baby', 'theirs', input(), NOW);
    await queueAdd(USER, BABY, 'ours', input(), NOW);

    const sent: string[] = [];
    await runOutbox(SCOPE, async (id) => {
      sent.push(id);
      return stored(id);
    }, () => NOW + 100);

    expect(sent).toEqual(['ours']);
    expect(await listQueued(otherScope)).toHaveLength(1);
  });
});

describe('what a person can do with a stopped entry', () => {
  it('starts the counters again on a manual retry', async () => {
    await putQueued(entry({ attempts: 7, state: 'failed', nextAttemptAt: NOW + MAX_DELAY_MS }));
    const after = await retryQueued(SCOPE, 'event-1', NOW);

    expect(after.attempts).toBe(0);
    expect(after.state).toBe('queued');
    expect(after.nextAttemptAt).toBe(NOW);
  });

  it('keeps the doubt through a manual retry', async () => {
    await putQueued(entry({ outcomeUnknown: true, state: 'failed' }));
    expect((await retryQueued(SCOPE, 'event-1', NOW)).outcomeUnknown).toBe(true);
  });

  it('takes a correction when the server definitely never had it', async () => {
    await putQueued(entry({ state: 'failed', lastCode: 'VALIDATION_FAILED' }));
    const after = await correctQueued(SCOPE, 'event-1', input({ value: 100 }), NOW);

    expect(after.input.value).toBe(100);
    expect(after.eventId).toBe('event-1');
  });

  it('refuses a correction while the outcome is unknown', async () => {
    await putQueued(entry({ outcomeUnknown: true, state: 'failed' }));

    // The server may hold the original. A corrected POST under the same id
    // comes back as the stored event, and the correction is gone with
    // nothing on screen to say so (spec 6.1).
    await expect(correctQueued(SCOPE, 'event-1', input({ value: 100 }), NOW)).rejects.toThrow();
    expect((await getQueued(SCOPE, 'event-1'))?.input.value).toBe(150);
  });

  it('says so when the queue sent it while the screen was open', async () => {
    await expect(retryQueued(SCOPE, 'nothing-here', NOW)).rejects.toBeInstanceOf(EntryGone);
    await expect(correctQueued(SCOPE, 'nothing-here', input(), NOW)).rejects.toBeInstanceOf(EntryGone);
  });
});

describe('taking over what the old store was holding', () => {
  const legacy = (eventId: string, userId = USER, babyId = BABY): unknown => ({
    userId,
    babyId,
    eventId,
    input: input(),
  });

  it('moves every entry, keeping its id', async () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([legacy('a'), legacy('b')]));

    expect(await migrateLegacyPending(NOW)).toBe(2);
    expect((await listQueued(SCOPE)).map((row) => row.eventId)).toEqual(['a', 'b']);
  });

  it('brings them across in doubt, because that is why they existed', async () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([legacy('a')]));
    await migrateLegacyPending(NOW);

    // Each one is there because an attempt ended in silence. The queue
    // will resend the original under the original id, which is exactly
    // how that doubt is meant to be settled (spec 6.1).
    const row = await getQueued(SCOPE, 'a');
    expect(row?.outcomeUnknown).toBe(true);
    expect(row?.state).toBe('queued');
    expect(row?.input.value).toBe(150);
  });

  it('files each one under the account that made it', async () => {
    localStorage.setItem(
      'dongfan.pending-creates',
      JSON.stringify([legacy('mine'), legacy('theirs', 'other-parent', 'other-baby')]),
    );
    await migrateLegacyPending(NOW);

    // Sending one account's record as another would be worse than losing
    // it: it would be filed against the wrong family (spec 6.1).
    expect((await listQueued(SCOPE)).map((row) => row.eventId)).toEqual(['mine']);
    expect((await listQueued(scopeOf('other-parent', 'other-baby'))).map((row) => row.eventId))
      .toEqual(['theirs']);
  });

  it('empties the old store, so nothing is sent twice', async () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([legacy('a')]));
    await migrateLegacyPending(NOW);

    expect(localStorage.getItem('dongfan.pending-creates')).toBeNull();
    expect(await migrateLegacyPending(NOW)).toBe(0);
  });

  it('does not reset an entry the queue has already been working on', async () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([legacy('a')]));
    await putQueued(entry({ eventId: 'a', attempts: 4, state: 'failed', lastCode: 'FORBIDDEN' }));

    await migrateLegacyPending(NOW);

    const row = await getQueued(SCOPE, 'a');
    expect(row?.attempts).toBe(4);
    expect(row?.state).toBe('failed');
  });

  it('ignores anything that is not shaped like an entry', async () => {
    localStorage.setItem('dongfan.pending-creates', JSON.stringify([legacy('a'), { nonsense: true }, 7]));
    expect(await migrateLegacyPending(NOW)).toBe(1);
  });

  it('survives a corrupt store rather than taking the app down with it', async () => {
    localStorage.setItem('dongfan.pending-creates', 'not json');
    expect(await migrateLegacyPending(NOW)).toBe(0);
  });
});
