import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBaby, createEvent, deleteEvent, json, patchEvent, request, signedInUser,
} from './helpers.js';
import type { StoredEvent } from './helpers.js';

/**
 * Incremental sync (spec 5.4).
 *
 * The cursor is a rev the server allocated, never a timestamp. Everything
 * here is about the ways a cursor loses data without anything failing: two
 * rows sharing a rev, a page reporting a cursor it did not reach, a deletion
 * that never gets a rev of its own.
 */

const HOUR = 3_600_000;

let token: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser();
  token = user.token;
  babyId = await createBaby(token, { birthDate: '2026-03-08' });
});

type Page = { events: StoredEvent[]; nextRev: number; hasMore: boolean };

async function sync(since = 0, limit?: number): Promise<Page> {
  const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
  return json<Page>(await request(`/api/babies/${babyId}/events?${query}`, {}, token));
}

describe('the sync feed', () => {
  it('returns everything from the beginning, in write order', async () => {
    const first = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    const second = await createEvent(token, babyId, { typeId: 'diaper', metadata: { diaper_kind: 'pee' } });

    const page = await sync(0);
    expect(page.events.map((e) => e.id)).toEqual([first.id, second.id]);
    expect(page.events.map((e) => e.rev)).toEqual([1, 2]);
    expect(page.hasMore).toBe(false);
  });

  it('gives every write a rev of its own', async () => {
    const created = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    await createEvent(token, babyId, { typeId: 'bottle', value: 110 });
    await patchEvent(token, created.id, { version: created.version, value: 120 });
    const third = await createEvent(token, babyId, { typeId: 'bottle', value: 130 });
    await deleteEvent(token, third.id, third.version);

    const revs = (await sync(0)).events.map((e) => e.rev);
    // A shared rev is not a crash, it is a page boundary that silently drops
    // whatever sat on the far side of it (spec 5.4).
    expect(new Set(revs).size).toBe(revs.length);
  });

  it('reports the last rev of the page, not the highest in the table', async () => {
    for (const value of [100, 110, 120, 130]) {
      await createEvent(token, babyId, { typeId: 'bottle', value });
    }

    const page = await sync(0, 2);
    const last = page.events[page.events.length - 1];

    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextRev).toBe(last?.rev);
    // Taking MAX(rev) instead would skip everything written between the two
    // queries, and nothing would ever report it.
    expect(page.nextRev).toBeLessThan(4);
  });

  it('carries on from the cursor it handed out', async () => {
    for (const value of [100, 110, 120, 130]) {
      await createEvent(token, babyId, { typeId: 'bottle', value });
    }

    const first = await sync(0, 2);
    const second = await sync(first.nextRev, 2);

    expect(second.events.map((e) => e.rev)).toEqual([3, 4]);
    expect(second.hasMore).toBe(false);
    const overlap = second.events.filter((e) => first.events.some((f) => f.id === e.id));
    expect(overlap).toEqual([]);
  });

  it('hands an empty page back the cursor it was given', async () => {
    await createEvent(token, babyId, { typeId: 'bottle', value: 100 });

    const page = await sync(9);
    expect(page.events).toEqual([]);
    // Zero or null here would send the client back to the start of history.
    expect(page.nextRev).toBe(9);
    expect(page.hasMore).toBe(false);
  });

  it('includes tombstones so the other phone learns about a deletion', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    const upTo = (await sync(0)).nextRev;

    await deleteEvent(token, event.id, event.version);

    const page = await sync(upTo);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.id).toBe(event.id);
    expect(page.events[0]?.deletedAt).not.toBeNull();
  });

  it('carries the tags of each event without a query per row', async () => {
    const tagId = await json<{ id: string }>(
      await request(`/api/babies/${babyId}/tags`, { method: 'POST', body: JSON.stringify({ name: 'night' }) }, token),
    ).then((tag) => tag.id);

    await createEvent(token, babyId, { typeId: 'bottle', value: 100, tagIds: [tagId] });
    await createEvent(token, babyId, { typeId: 'bottle', value: 110 });

    const page = await sync(0);
    expect(page.events[0]?.tagIds).toEqual([tagId]);
    expect(page.events[1]?.tagIds).toEqual([]);
  });

  it('keeps one baby out of another baby’s feed', async () => {
    const sibling = await createBaby(token, { nickname: 'Sibling', birthDate: '2026-03-08' });
    await createEvent(token, sibling, { typeId: 'bottle', value: 100 });
    await createEvent(token, babyId, { typeId: 'bottle', value: 110 });

    const page = await sync(0);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.babyId).toBe(babyId);
  });

  it('refuses a caller with no access to the baby', async () => {
    const other = await signedInUser('outsider', 'a-sufficiently-long-password');
    const response = await request(`/api/babies/${babyId}/events?since=0`, {}, other.token);
    expect(response.status).toBe(404);
  });

  it('refuses a limit beyond what a single page may carry', async () => {
    const response = await request(`/api/babies/${babyId}/events?since=0&limit=5000`, {}, token);
    expect(response.status).toBe(422);
  });
});

describe('one calendar day', () => {
  it('returns that day in the baby timezone, newest first', async () => {
    const now = Date.now();
    const early = await createEvent(token, babyId, { typeId: 'bottle', value: 100, startedAt: now - 3 * HOUR });
    const late = await createEvent(token, babyId, { typeId: 'bottle', value: 110, startedAt: now - HOUR });

    const date = late.localDate;
    const body = await json<{ date: string; events: StoredEvent[] }>(
      await request(`/api/babies/${babyId}/events/day/${date}`, {}, token),
    );

    expect(body.date).toBe(date);
    const ids = body.events.map((e) => e.id);
    expect(ids.indexOf(late.id)).toBeLessThan(ids.indexOf(early.id));
  });

  it('leaves deleted events out of the day, unlike the sync feed', async () => {
    const event = await createEvent(token, babyId, { typeId: 'bottle', value: 100 });
    await deleteEvent(token, event.id, event.version);

    const body = await json<{ events: StoredEvent[] }>(
      await request(`/api/babies/${babyId}/events/day/${event.localDate}`, {}, token),
    );
    expect(body.events).toEqual([]);
  });

  it('refuses a date that is not a day', async () => {
    const response = await request(`/api/babies/${babyId}/events/day/2026-02-31`, {}, token);
    expect(response.status).toBe(422);
  });
});
