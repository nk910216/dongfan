import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_EVENTS_PER_DAY, startOfLocalDay, toLocalDate,
} from '@dongfan/shared';
import {
  createBaby, createEvent, createTag, deleteEvent, json, newId, patchEvent,
  postEvent, request, signedInUser,
} from './helpers.js';
import type { StoredEvent } from './helpers.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * Event integration tests, against a real local D1.
 *
 * The bugs worth catching here do not throw: a second running timer, a rev
 * shared by two rows, a conflict reported after the tags were already
 * rewritten. None of those fail a mocked SQL layer, so none of these run
 * against one (spec 11.2).
 */

const TZ = 'Asia/Taipei';
const HOUR = 3_600_000;

type Failure = { error: { code: string; details: { fields?: { field: string; code: string; params: Record<string, unknown> }[] } | null } };

async function failure(response: Response): Promise<Failure['error']> {
  return (await json<Failure>(response)).error;
}

async function fieldCodes(response: Response): Promise<string[]> {
  const error = await failure(response);
  return (error.details?.fields ?? []).map((f) => `${f.field}:${f.code}`);
}

let token: string;
let userId: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser();
  token = user.token;
  userId = user.id;
  babyId = await createBaby(token, { birthDate: '2026-03-08', timezone: TZ });
});

describe('creating an event', () => {
  it('stores it and hands back the server-assigned fields', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 140 });

    expect(event.value).toBe(140);
    expect(event.version).toBe(1);
    expect(event.rev).toBe(1);
    expect(event.active).toBe(false);
    expect(event.deletedAt).toBeNull();
    expect(event.localDate).toBe(toLocalDate(event.startedAt, TZ));
  });

  it('refuses an anonymous caller', async () => {
    const response = await request(`/api/babies/${babyId}/events`, {
      method: 'POST',
      body: JSON.stringify({ id: newId(), typeId: 'bottle', intent: 'record', startedAt: Date.now(), endedAt: null, value: 1 }),
    });
    expect(response.status).toBe(401);
  });

  it('hides another family’s baby behind a 404 rather than a 403', async () => {
    const other = await signedInUser('other', 'another-long-password-here');
    const response = await postEvent(other.token, babyId, { typeId: 'bottle', value: 1 });
    expect(response.status).toBe(404);
  });

  it('rejects a type that is not in the config', async () => {
    const response = await postEvent(token, babyId, { typeId: 'teleportation' });
    expect(response.status).toBe(422);
    expect(await fieldCodes(response)).toContain('typeId:INVALID_ENUM');
  });

  it('reports the amount bounds in the units the parent typed', async () => {
    const response = await postEvent(token, babyId, { typeId: 'temperature', value: 9000 });
    expect(response.status).toBe(422);

    const error = await failure(response);
    const field = error.details?.fields?.[0];
    expect(field?.code).toBe('OUT_OF_RANGE');
    // Stored in tenths, so 9000 means 900 degrees. Reporting the bounds in
    // stored units would read as "between 340 and 420" to someone who typed
    // a temperature (spec 5.2.1).
    expect(field?.params).toEqual({ min: 34, max: 42 });
  });

  it('refuses a metadata key the type does not define', async () => {
    const response = await postEvent(token, babyId, {
      typeId: 'diaper',
      metadata: { diaper_kind: 'pee', colour: 'green' },
    });
    expect(response.status).toBe(422);
    expect(await fieldCodes(response)).toContain('metadata.colour:UNKNOWN_FIELD');
  });

  it('refuses a value outside an enum', async () => {
    const response = await postEvent(token, babyId, {
      typeId: 'diaper',
      metadata: { diaper_kind: 'sideways' },
    });
    expect(await fieldCodes(response)).toContain('metadata.diaper_kind:INVALID_ENUM');
  });

  it('requires a milestone to be named', async () => {
    const response = await postEvent(token, babyId, { typeId: 'milestone', metadata: {} });
    expect(await fieldCodes(response)).toContain('metadata.title:REQUIRED');
  });

  it('computes local_date in the baby timezone, not UTC', async () => {
    // Half past midnight in Taipei is still the previous day in UTC, which
    // is the night feed that a UTC-derived date would file under yesterday.
    const today = toLocalDate(Date.now(), TZ);
    const smallHours = startOfLocalDay(today, TZ) + 30 * 60_000;

    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 90, startedAt: smallHours });

    expect(event.localDate).toBe(today);
    expect(new Date(smallHours).toISOString().slice(0, 10)).not.toBe(today);
  });

  it('ignores a local_date supplied by the client', async () => {
    const response = await request(
      `/api/babies/${babyId}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: newId(), typeId: 'bottle', intent: 'record',
          startedAt: Date.now(), endedAt: null, value: 100,
          local_date: '1999-01-01', localDate: '1999-01-01',
        }),
      },
      token,
    );

    const event = await json<StoredEvent>(response);
    expect(event.localDate).toBe(toLocalDate(event.startedAt, TZ));
  });

  it('returns a parent’s own words byte for byte', async () => {
    const event = await createEvent(token, babyId, {
      typeId: 'solid_food',
      note: USER_CONTENT.noteWithEmoji,
      metadata: { food_name: USER_CONTENT.nickname },
    });

    expect(event.note).toBe(USER_CONTENT.noteWithEmoji);
    expect(event.metadata['food_name']).toBe(USER_CONTENT.nickname);
  });

  it('pins an all-day event to local midnight', async () => {
    const event = await createEvent(token, babyId, {
      typeId: 'milestone',
      metadata: { title: USER_CONTENT.note },
      startedAt: Date.now(),
    });

    expect(event.startedAt).toBe(startOfLocalDay(event.localDate, TZ));
    expect(event.endedAt).toBeNull();
  });

  it('refuses to start a timer on a type that has none', async () => {
    const response = await postEvent(token, babyId, { typeId: 'bottle', intent: 'start_timer', value: 100 });
    expect(await fieldCodes(response)).toContain('intent:INVALID_ENUM');
  });

  it('refuses an end time on a type with no range', async () => {
    const response = await postEvent(token, babyId, {
      typeId: 'bottle', value: 100, endedAt: Date.now(),
    });
    expect(await fieldCodes(response)).toContain('endedAt:UNKNOWN_FIELD');
  });

  it('refuses a timestamp more than a day ahead', async () => {
    const response = await postEvent(token, babyId, {
      typeId: 'bottle', value: 100, startedAt: Date.now() + 3 * 24 * HOUR,
    });
    expect(await fieldCodes(response)).toContain('startedAt:TOO_FAR_IN_FUTURE');
  });

  it('refuses a timestamp from before the baby was born', async () => {
    const response = await postEvent(token, babyId, {
      typeId: 'bottle', value: 100, startedAt: Date.parse('2026-01-01T00:00:00Z'),
    });
    expect(await fieldCodes(response)).toContain('startedAt:BEFORE_BIRTH');
  });

  it('refuses a span longer than a day, which is what keeps splitting simple', async () => {
    const started = Date.now() - 30 * HOUR;
    const response = await postEvent(token, babyId, {
      typeId: 'sleep', startedAt: started, endedAt: started + 25 * HOUR,
    });
    expect(await fieldCodes(response)).toContain('endedAt:DURATION_TOO_LONG');
  });

  it('refuses an end time before the start', async () => {
    const started = Date.now();
    const response = await postEvent(token, babyId, {
      typeId: 'sleep', startedAt: started, endedAt: started - HOUR,
    });
    expect(await fieldCodes(response)).toContain('endedAt:END_BEFORE_START');
  });
});

describe('the daily circuit breaker', () => {
  /** Fills a day directly, which is far quicker than five hundred requests. */
  async function fillDay(date: string, count: number): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
       INSERT INTO events (id, baby_id, type_id, created_by, created_at, updated_at,
                           started_at, ended_at, local_date, value, note, metadata,
                           version, rev, active, deleted_at)
       SELECT 'filler-' || n, ?, 'bottle', ?, ?, ?, ?, NULL, ?, 1, '', '{}', 1,
              (SELECT COALESCE(MAX(rev), 0) FROM events WHERE baby_id = ?) + n, NULL, ?
         FROM seq`,
    )
      .bind(count, babyId, userId, now, now, now, date, babyId, now)
      .run();
  }

  it('stops runaway writes once the day is full', async () => {
    const today = toLocalDate(Date.now(), TZ);
    // Soft-deleted, because a create-delete-create loop must not be able to
    // walk past the limit by leaving no live rows behind (spec 5.7).
    await fillDay(today, MAX_EVENTS_PER_DAY);

    const response = await postEvent(token, babyId, { typeId: 'bottle', value: 100 });
    expect(response.status).toBe(429);
    expect((await failure(response)).code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  it('still accepts the resend of an event that is already stored', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 120 });
    await fillDay(toLocalDate(Date.now(), TZ), MAX_EVENTS_PER_DAY);

    // Checking the limit before the idempotent read-back would fail the
    // five hundredth event's resend, although it is already in (spec 5.8).
    const again = await postEvent(token, babyId, {
      id: event.id, typeId: 'bottle', value: 120, startedAt: event.startedAt,
    });
    expect(again.status).toBe(200);
  });
});

describe('resending a POST whose response was lost', () => {
  it('returns the stored event instead of creating a second one', async () => {
    const id = newId();
    const startedAt = Date.now();
    const first = await createEvent(token, babyId, { id, typeId: 'bottle', value: 150, startedAt });

    const second = await postEvent(token, babyId, { id, typeId: 'bottle', value: 150, startedAt });
    expect(second.status).toBe(200);

    const body = await json<StoredEvent>(second);
    expect(body).toEqual(first);

    const page = await json<{ events: StoredEvent[] }>(
      await request(`/api/babies/${babyId}/events?since=0`, {}, token),
    );
    expect(page.events.filter((e) => e.typeId === 'bottle')).toHaveLength(1);
  });

  it('does not let a corrected resend overwrite what is stored', async () => {
    const id = newId();
    const original = await createEvent(token, babyId, { id, typeId: 'bottle', value: 80 });

    // The queue is not allowed to fix an event by POSTing over it: the
    // server would answer "already have it" and the correction would vanish
    // without a trace. Corrections go through PATCH (spec 6.1).
    const corrected = await postEvent(token, babyId, { id, typeId: 'bottle', value: 100 });
    expect(corrected.status).toBe(200);

    const body = await json<StoredEvent>(corrected);
    expect(body.value).toBe(80);
    expect(body.version).toBe(original.version);
  });

  it('refuses an id that belongs to another baby without revealing it', async () => {
    const otherBaby = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    const mine = await createEvent(token, otherBaby, { typeId: 'bottle', value: 60, note: 'secret' });

    // Reading back on the id alone would hand this event to a request that
    // only proved access to a different baby (spec 5.8).
    const response = await postEvent(token, babyId, { id: mine.id, typeId: 'bottle', value: 60 });
    expect(response.status).toBe(409);

    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe('ID_CONFLICT');
    expect(text).not.toContain('secret');
  });
});

describe('the single running timer', () => {
  it('lets exactly one of two simultaneous starts through', async () => {
    const [a, b] = await Promise.all([
      postEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' }),
      postEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' }),
    ]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    expect((await failure(loser)).code).toBe('ACTIVE_TIMER_EXISTS');

    const running = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM events WHERE baby_id = ? AND type_id = ? AND active = 1')
      .bind(babyId, 'sleep')
      .first<{ n: number }>();
    expect(running?.n).toBe(1);
  });

  it('turns the second start down while the first is still running', async () => {
    await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    const second = await postEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });

    expect(second.status).toBe(409);
    expect((await failure(second)).code).toBe('ACTIVE_TIMER_EXISTS');
  });

  it('still allows a back-filled record of the same type', async () => {
    const started = Date.now() - 5 * HOUR;
    await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });

    // Only a running timer holds the slot. Someone writing up last night's
    // sleep must not be blocked by this morning's nap (spec 3.5).
    const back = await createEvent(token, babyId, {
      typeId: 'sleep', intent: 'record', startedAt: started, endedAt: started + 2 * HOUR,
    });
    expect(back.active).toBe(false);
  });

  it('does not stop a second nappy, which has no timer at all', async () => {
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'pee' } });
    const second = await postEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'poo' } });
    expect(second.status).toBe(201);
  });
});

describe('stopping a timer', () => {
  it('clears the slot and moves the version and the rev', async () => {
    const started = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });

    const response = await patchEvent(token, started.id, {
      version: started.version,
      endedAt: started.startedAt + 2 * HOUR,
    });
    expect(response.status).toBe(200);

    const stopped = await json<StoredEvent>(response);
    expect(stopped.active).toBe(false);
    expect(stopped.endedAt).toBe(started.startedAt + 2 * HOUR);
    expect(stopped.version).toBe(started.version + 1);
    expect(stopped.rev).toBeGreaterThan(started.rev);

    // And the slot is genuinely free again.
    const again = await postEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    expect(again.status).toBe(201);
  });

  it('refuses to stop a timer that has run past a day', async () => {
    const started = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });

    const response = await patchEvent(token, started.id, {
      version: started.version,
      endedAt: started.startedAt + 25 * HOUR,
    });
    expect(await fieldCodes(response)).toContain('endedAt:DURATION_TOO_LONG');
  });

  it('turns a second stop down rather than rewriting the first', async () => {
    const started = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    const first = started.startedAt + HOUR;

    await patchEvent(token, started.id, { version: started.version, endedAt: first });
    const second = await patchEvent(token, started.id, {
      version: started.version,
      endedAt: started.startedAt + 2 * HOUR,
    });

    expect(second.status).toBe(409);
    expect((await failure(second)).code).toBe('VERSION_CONFLICT');

    const current = await json<StoredEvent>(await request(`/api/events/${started.id}`, {}, token));
    expect(current.endedAt).toBe(first);
  });
});

describe('a version conflict', () => {
  async function withTags(names: string[]): Promise<{ event: StoredEvent; tagIds: string[] }> {
    const tagIds = [];
    for (const name of names) tagIds.push(await createTag(token, babyId, name));
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 110, tagIds });
    return { event, tagIds: [...tagIds].sort() };
  }

  it('leaves the event and its tags completely untouched', async () => {
    const { event, tagIds } = await withTags([USER_CONTENT.tagName, 'night']);
    const stale = event.version;

    // Somebody else edits first, moving the version on.
    await patchEvent(token, event.id, { version: stale, value: 130 });

    const conflicted = await patchEvent(token, event.id, {
      version: stale,
      value: 200,
      note: 'this must not land',
      tagIds: [],
    });
    expect(conflicted.status).toBe(409);

    // The whole point: the tag rows are still there. A guard applied after
    // the batch returned would have deleted them and then reported failure.
    const current = await json<StoredEvent>(await request(`/api/events/${event.id}`, {}, token));
    expect(current.value).toBe(130);
    expect(current.note).toBe(event.note);
    expect(current.tagIds).toEqual(tagIds);
  });

  it('adds nothing when the losing patch was trying to attach a tag', async () => {
    const { event } = await withTags([]);
    const stale = event.version;
    const newTag = await createTag(token, babyId, 'clinic');

    await patchEvent(token, event.id, { version: stale, note: 'first writer wins' });

    const conflicted = await patchEvent(token, event.id, { version: stale, tagIds: [newTag] });
    expect(conflicted.status).toBe(409);

    const current = await json<StoredEvent>(await request(`/api/events/${event.id}`, {}, token));
    expect(current.tagIds).toEqual([]);
    expect(current.note).toBe('first writer wins');
  });

  it('refuses a tag belonging to a different baby', async () => {
    const otherBaby = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    const foreign = await createTag(token, otherBaby, 'theirs');

    const response = await postEvent(token, babyId, { typeId: 'bottle', value: 100, tagIds: [foreign] });
    expect(response.status).toBe(422);
    expect(await fieldCodes(response)).toContain('tagIds.0:INVALID_ENUM');
  });
});

describe('deleting an event', () => {
  it('leaves a tombstone rather than removing the row', async () => {
    const event = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });

    const response = await deleteEvent(token, event.id, event.version);
    expect(response.status).toBe(200);

    const tombstone = await json<StoredEvent>(response);
    expect(tombstone.deletedAt).not.toBeNull();
    expect(tombstone.version).toBe(event.version + 1);
    // Without a new rev the other phone never learns about the deletion.
    expect(tombstone.rev).toBeGreaterThan(event.rev);
    // And the timer slot has to come back, or that type is stuck forever.
    expect(tombstone.active).toBe(false);

    const again = await postEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    expect(again.status).toBe(201);
  });

  it('refuses a stale version', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    await patchEvent(token, event.id, { version: event.version, value: 110 });

    const response = await deleteEvent(token, event.id, event.version);
    expect(response.status).toBe(409);
  });

  it('answers a second deletion with a not-found', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    await deleteEvent(token, event.id, event.version);

    const response = await deleteEvent(token, event.id, event.version + 1);
    expect(response.status).toBe(404);
  });

  it('is refused to someone with no access to the baby', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    const other = await signedInUser('stranger', 'yet-another-long-password');

    const response = await deleteEvent(other.token, event.id, event.version);
    expect(response.status).toBe(404);
  });
});

describe('two requests carrying the same id', () => {
  it('never hands one baby’s event to a request for another', async () => {
    const sibling = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    const shared = newId();

    const [a, b] = await Promise.all([
      postEvent(token, babyId, { id: shared, typeId: 'bottle', value: 100, note: 'first baby' }),
      postEvent(token, sibling, { id: shared, typeId: 'bottle', value: 100, note: 'second baby' }),
    ]);

    // One of them created it; the other must be told the id is taken and be
    // shown nothing. Whichever way the two interleave, the answer is the
    // same: the path proves access to one baby, the id proves nothing.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    const text = await loser.text();
    expect(JSON.parse(text).error.code).toBe('ID_CONFLICT');
    expect(text).not.toContain('first baby');
    expect(text).not.toContain('second baby');
  });

  it('does not let the loser attach its own tags to the winner’s event', async () => {
    const mine = await createTag(token, babyId, 'mine');
    const theirs = await createTag(token, babyId, 'theirs');
    const shared = newId();
    const startedAt = Date.now();

    const [a, b] = await Promise.all([
      postEvent(token, babyId, { id: shared, typeId: 'bottle', value: 100, startedAt, tagIds: [mine] }),
      postEvent(token, babyId, { id: shared, typeId: 'bottle', value: 100, startedAt, tagIds: [theirs] }),
    ]);

    // Exactly one creation. The other is a resend by definition, and a
    // resend changes nothing at all (spec 5.8).
    expect([a.status, b.status].sort()).toEqual([200, 201]);

    const stored = await json<StoredEvent>(
      await request(`/api/events/${shared}`, {}, token),
    );
    expect(stored.tagIds).toHaveLength(1);
    expect(stored.version).toBe(1);
    expect(stored.rev).toBe(1);
  });

  it('rolls the tag writes back when the id turns out to be taken', async () => {
    // The statements the create path sends, driven directly, because the
    // handler returns before reaching them on a sequential resend. Inside a
    // batch there is no branching: the only thing that can stop the tag
    // writes is the insert before them failing. An `ON CONFLICT DO NOTHING`
    // there would let them through, onto a row this request did not create,
    // with no version and no rev to tell another device about it.
    const tagId = await createTag(token, babyId, 'evening');
    const first = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });

    const now = first.startedAt + 1000;
    const batch = env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, baby_id, type_id, created_by, created_at, updated_at,
                             started_at, ended_at, local_date, value, note, metadata,
                             version, rev, active, deleted_at)
         VALUES (?, ?, 'bottle', ?, ?, ?, ?, NULL, ?, 1, '', '{}', 1,
                 (SELECT COALESCE(MAX(rev), 0) + 1 FROM events WHERE baby_id = ?), NULL, NULL)`,
      ).bind(first.id, babyId, userId, now, now, now, first.localDate, babyId),
      env.DB.prepare(
        `INSERT INTO event_tags (event_id, tag_id)
         SELECT e.id, t.id
           FROM events e
           JOIN tags t ON t.baby_id = e.baby_id
          WHERE e.id = ? AND t.id = ? AND e.baby_id = ?
         ON CONFLICT DO NOTHING`,
      ).bind(first.id, tagId, babyId),
    ]);

    await expect(batch).rejects.toThrow();

    const after = await json<StoredEvent>(await request(`/api/events/${first.id}`, {}, token));
    expect(after.tagIds).toEqual([]);
    expect(after.version).toBe(first.version);
    expect(after.rev).toBe(first.rev);
  });
});
