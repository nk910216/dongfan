import { beforeEach, describe, expect, it } from 'vitest';
import { startOfLocalDay, toLocalDate } from '@dongfan/shared';
import {
  createBaby, createEvent, deleteEvent, json, patchEvent, request, signedInUser, summary,
} from './helpers.js';
import type { StoredEvent } from './helpers.js';

/**
 * The home screen summary (spec 5.5).
 *
 * Every figure here has a definition that two implementers would otherwise
 * get differently: what counts as a feed, whether expressed milk is intake,
 * what "both" does to the nappy counts, and which row a type's last value
 * comes from when a timer is still running.
 */

const TZ = 'Asia/Taipei';
const HOUR = 3_600_000;
const MINUTE = 60_000;

let token: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser();
  token = user.token;
  babyId = await createBaby(token, { birthDate: '2026-03-08', timezone: TZ });
});

function forType(types: Awaited<ReturnType<typeof summary>>['types'], typeId: string) {
  return types.find((entry) => entry.typeId === typeId);
}

describe('per type figures', () => {
  it('takes the last row and the running row separately', async () => {
    const now = Date.now();
    const running = await createEvent(token, babyId, {
      typeId: 'sleep', intent: 'start_timer', startedAt: now - 3 * HOUR,
    });
    // Written up afterwards but started later: the newest sleep row is not
    // the one holding the timer. A GROUP BY with bare columns would pair
    // this row's id with that row's start (spec 5.5).
    const backFilled = await createEvent(token, babyId, {
      typeId: 'sleep', intent: 'record', startedAt: now - 2 * HOUR, endedAt: now - HOUR,
    });

    const sleep = forType((await summary(token, babyId)).types, 'sleep');

    expect(sleep?.lastStartedAt).toBe(backFilled.startedAt);
    expect(sleep?.activeEventId).toBe(running.id);
    expect(sleep?.activeStartedAt).toBe(running.startedAt);
  });

  it('carries the version a client needs to stop the timer', async () => {
    const started = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    const sleep = forType((await summary(token, babyId)).types, 'sleep');

    expect(sleep?.activeVersion).toBe(started.version);

    // Without it the client would have to fetch the event first, and across
    // midnight that event is not in today's list at all (spec 5.5).
    const stop = await patchEvent(token, started.id, {
      version: sleep?.activeVersion ?? 0,
      endedAt: started.startedAt + HOUR,
    });
    expect(stop.status).toBe(200);
  });

  it('reports nothing running once the timer is stopped', async () => {
    const started = await createEvent(token, babyId, { typeId: 'sleep', intent: 'start_timer' });
    await patchEvent(token, started.id, { version: started.version, endedAt: started.startedAt + HOUR });

    const sleep = forType((await summary(token, babyId)).types, 'sleep');
    expect(sleep?.activeEventId).toBeNull();
    expect(sleep?.activeVersion).toBeNull();
  });

  it('breaks ties on the id so the figure does not wobble between reloads', async () => {
    const at = Date.now() - HOUR;
    const a = await createEvent(token, babyId, { typeId: 'weight', value: 7400, startedAt: at });
    const b = await createEvent(token, babyId, { typeId: 'weight', value: 7500, startedAt: at });

    const expected = a.id > b.id ? a.value : b.value;
    const first = forType((await summary(token, babyId)).types, 'weight');
    const second = forType((await summary(token, babyId)).types, 'weight');

    expect(first?.lastValue).toBe(expected);
    expect(second?.lastValue).toBe(expected);
  });

  it('forgets a deleted event', async () => {
    const event = await createEvent(token, babyId, { typeId: 'weight', value: 7400 });
    await deleteEvent(token, event.id, event.version);

    expect(forType((await summary(token, babyId)).types, 'weight')).toBeUndefined();
  });
});

describe('today’s totals', () => {
  it('adds up bottles and leaves expressed milk out of it', async () => {
    await createEvent(token, babyId, { typeId: 'bottle', value: 140 });
    await createEvent(token, babyId, { typeId: 'bottle', value: 120 });
    // Pumping measures what came out of a parent, not what went into the
    // baby. Counting it would roughly double the number (spec 5.5).
    await createEvent(token, babyId, { typeId: 'pumping', value: 200 });

    expect((await summary(token, babyId)).today.totalBottleMl).toBe(260);
  });

  it('counts a combined nappy towards both kinds and keeps it visible', async () => {
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'pee' } });
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'pee' } });
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'poo' } });
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'both' } });
    await createEvent(token, babyId, { typeId: 'diaper', metadata: {} });

    const { diaper } = (await summary(token, babyId)).today;

    expect(diaper.pee).toBe(3);
    expect(diaper.poo).toBe(2);
    expect(diaper.both).toBe(1);
    // Not folded into pee or poo: a half-filled record is not a wet nappy.
    expect(diaper.unknown).toBe(1);
    // The count of events, which is pee + poo - both + unknown.
    expect(diaper.total).toBe(5);
    expect(diaper.total).toBe(diaper.pee + diaper.poo - diaper.both + diaper.unknown);
  });

  it('counts only the baby timezone’s today', async () => {
    const today = toLocalDate(Date.now(), TZ);
    const lastNight = startOfLocalDay(today, TZ) - 30 * MINUTE;

    await createEvent(token, babyId, { typeId: 'bottle', value: 90, startedAt: lastNight });
    await createEvent(token, babyId, { typeId: 'bottle', value: 110 });

    const body = await summary(token, babyId);
    expect(body.date).toBe(today);
    expect(body.today.totalBottleMl).toBe(110);
  });

  it('leaves a deleted bottle out of the total', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 140 });
    await createEvent(token, babyId, { typeId: 'bottle', value: 120 });
    await deleteEvent(token, event.id, event.version);

    expect((await summary(token, babyId)).today.totalBottleMl).toBe(120);
  });
});

describe('the last feed', () => {
  it('reaches back past midnight, which is when it is most needed', async () => {
    const today = toLocalDate(Date.now(), TZ);
    const lateLastNight = startOfLocalDay(today, TZ) - 10 * MINUTE;

    await createEvent(token, babyId, { typeId: 'bottle', value: 120, startedAt: lateLastNight });

    // Scoped to today, a parent opening the app at half past midnight would
    // be told there has been no feed at all (spec 5.5).
    const body = await summary(token, babyId);
    expect(body.lastFeedAt).toBe(lateLastNight);
    expect(body.today.totalBottleMl).toBe(0);
  });

  it('covers nursing as well as bottles, whichever came later', async () => {
    const now = Date.now();
    await createEvent(token, babyId, { typeId: 'bottle', value: 120, startedAt: now - 3 * HOUR });
    const nursing = await createEvent(token, babyId, {
      typeId: 'nursing', intent: 'record', startedAt: now - HOUR, endedAt: now - 40 * MINUTE,
    });

    expect((await summary(token, babyId)).lastFeedAt).toBe(nursing.startedAt);
  });

  it('is null before anyone has fed the baby', async () => {
    await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'pee' } });
    expect((await summary(token, babyId)).lastFeedAt).toBeNull();
  });
});

describe('access', () => {
  it('is refused to someone with no claim on the baby', async () => {
    const other = await signedInUser('nobody', 'a-long-enough-password-here');
    const response = await request(`/api/babies/${babyId}/events/summary`, {}, other.token);
    expect(response.status).toBe(404);
  });

  it('summarises each baby on its own', async () => {
    const sibling = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    await createEvent(token, sibling, { typeId: 'bottle', value: 200 });

    expect((await summary(token, babyId)).today.totalBottleMl).toBe(100);
    expect((await summary(token, sibling)).today.totalBottleMl).toBe(200);
  });
});

describe('tags', () => {
  it('belong to the baby, so both parents see the same list', async () => {
    const created = await request(
      `/api/babies/${babyId}/tags`,
      { method: 'POST', body: JSON.stringify({ name: 'night' }) },
      token,
    );
    expect(created.status).toBe(201);

    const listed = await json<{ tags: { id: string; name: string }[] }>(
      await request(`/api/babies/${babyId}/tags`, {}, token),
    );
    expect(listed.tags.map((t) => t.name)).toEqual(['night']);
  });

  it('returns the existing tag when the same name is added twice', async () => {
    const first = await json<{ id: string }>(await request(
      `/api/babies/${babyId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'clinic' }) }, token,
    ));
    const second = await request(
      `/api/babies/${babyId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'clinic' }) }, token,
    );

    expect(second.status).toBe(200);
    expect((await json<{ id: string }>(second)).id).toBe(first.id);
  });

  it('are not visible from another baby', async () => {
    const sibling = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    await request(`/api/babies/${babyId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'night' }) }, token);

    const listed = await json<{ tags: StoredEvent[] }>(
      await request(`/api/babies/${sibling}/tags`, {}, token),
    );
    expect(listed.tags).toEqual([]);
  });
});
