import { beforeEach, describe, expect, it } from 'vitest';
import { createBaby, createEvent, json, request, signedInUser } from './helpers.js';
import type { StoredEvent } from './helpers.js';

/**
 * Renaming and deleting a tag (spec 7.9).
 *
 * Almost everything here is about a failure with no symptom. Incremental
 * sync watches `events.rev` and nothing else (spec 5.4), so a tag write that
 * does not move the events carrying it leaves the *other* phone showing an
 * old name, or a tag that no longer exists, for ever -- while this phone
 * looks perfectly correct and every response is a 200.
 *
 * Every fixture is invented and written through the API. Nothing reads a
 * database belonging to anybody.
 */

const HOUR = 3_600_000;

let token: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser();
  token = user.token;
  babyId = await createBaby(token, { birthDate: '2026-03-08' });
});

type Tag = { id: string; name: string; createdAt: number };

async function makeTag(name: string, as = token, baby = babyId): Promise<Tag> {
  const response = await request(
    `/api/babies/${baby}/tags`,
    { method: 'POST', body: JSON.stringify({ name }) },
    as,
  );
  return json<Tag>(response);
}

const rename = (tagId: string, name: string, as = token, baby = babyId): Promise<Response> =>
  request(
    `/api/babies/${baby}/tags/${tagId}`,
    { method: 'PATCH', body: JSON.stringify({ name }) },
    as,
  );

const remove = (tagId: string, as = token, baby = babyId): Promise<Response> =>
  request(`/api/babies/${baby}/tags/${tagId}`, { method: 'DELETE' }, as);

async function tagged(tagIds: string[], hoursAgo = 2): Promise<StoredEvent> {
  return createEvent(token, babyId, {
    id: crypto.randomUUID(),
    typeId: 'bottle',
    intent: 'record',
    startedAt: Date.now() - hoursAgo * HOUR,
    value: 120,
    tagIds,
  });
}

/** The sync feed as another device would read it. */
async function since(cursor: number): Promise<{ events: StoredEvent[]; nextRev: number }> {
  const response = await request(`/api/babies/${babyId}/events?since=${cursor}`, {}, token);
  return json<{ events: StoredEvent[]; nextRev: number }>(response);
}

async function listTags(): Promise<Tag[]> {
  const response = await request(`/api/babies/${babyId}/tags`, {}, token);
  return (await json<{ tags: Tag[] }>(response)).tags;
}

describe('renaming a tag', () => {
  it('answers with the new name', async () => {
    const tag = await makeTag('night');
    const response = await rename(tag.id, 'nights');

    expect(response.status).toBe(200);
    expect(await json<Tag>(response)).toMatchObject({ id: tag.id, name: 'nights' });
    expect((await listTags()).map((one) => one.name)).toEqual(['nights']);
  });

  it('moves every event carrying it, so the other phone hears about it', async () => {
    // The whole point. Without this the rename is invisible to the other
    // device: it never asks for tags, it asks for events after a rev.
    const tag = await makeTag('night');
    const first = await tagged([tag.id]);
    const second = await tagged([tag.id], 3);
    const untouched = await tagged([]);

    const before = (await since(0)).nextRev;
    expect(await rename(tag.id, 'nights')).toHaveProperty('status', 200);

    const feed = await since(before);
    const moved = feed.events.map((one) => one.id).sort();
    expect(moved).toEqual([first.id, second.id].sort());
    expect(moved).not.toContain(untouched.id);
  });

  it('gives every moved event a rev of its own', async () => {
    // Sharing one rev is the bug spec 5.4 names: a client that reads two of
    // three and stores the shared cursor never sees the third again. The
    // unique index would refuse the write, so this is a test that the
    // statement numbers each row rather than a test of SQLite.
    const tag = await makeTag('night');
    for (let i = 0; i < 4; i += 1) await tagged([tag.id], i + 1);

    const before = (await since(0)).nextRev;
    await rename(tag.id, 'nights');

    const revs = (await since(before)).events.map((one) => one.rev);
    expect(revs).toHaveLength(4);
    expect(new Set(revs).size).toBe(4);
  });

  it('is readable one page at a time, with nothing skipped', async () => {
    // What a shared rev actually costs: paging past it. Read in pages of
    // two, every event has to arrive exactly once.
    const tag = await makeTag('night');
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await tagged([tag.id], i + 1)).id);

    const before = (await since(0)).nextRev;
    await rename(tag.id, 'nights');

    const seen: string[] = [];
    let cursor = before;
    for (let page = 0; page < 10; page += 1) {
      const response = await request(
        `/api/babies/${babyId}/events?since=${cursor}&limit=2`,
        {},
        token,
      );
      const body = await json<{ events: StoredEvent[]; nextRev: number; hasMore: boolean }>(response);
      seen.push(...body.events.map((one) => one.id));
      cursor = body.nextRev;
      if (!body.hasMore) break;
    }

    expect(seen.sort()).toEqual([...made].sort());
  });

  it('touches nothing when the name has not changed', async () => {
    // A rename to the name it already has is a sync for no change, on a
    // list that can be long.
    const tag = await makeTag('night');
    await tagged([tag.id]);

    const before = (await since(0)).nextRev;
    expect((await rename(tag.id, 'night')).status).toBe(200);

    expect((await since(before)).events).toEqual([]);
  });

  it('refuses a name another tag already has', async () => {
    const night = await makeTag('night');
    await makeTag('day');

    const response = await rename(night.id, 'day');
    expect(response.status).toBe(409);
    expect(await json<{ error: { code: string } }>(response))
      .toMatchObject({ error: { code: 'TAG_NAME_TAKEN' } });
    expect((await listTags()).map((one) => one.name).sort()).toEqual(['day', 'night']);
  });

  it('refuses a name that is empty or too long', async () => {
    const tag = await makeTag('night');
    expect((await rename(tag.id, '')).status).toBe(422);
    expect((await rename(tag.id, 'x'.repeat(31))).status).toBe(422);
    expect((await listTags())[0]?.name).toBe('night');
  });
});

describe('deleting a tag', () => {
  it('removes it, and the associations with it', async () => {
    const tag = await makeTag('night');
    const event = await tagged([tag.id]);

    expect((await remove(tag.id)).status).toBe(204);
    expect(await listTags()).toEqual([]);

    const response = await request(`/api/events/${event.id}`, {}, token);
    expect((await json<StoredEvent>(response)).tagIds).toEqual([]);
  });

  it('moves every event it was on, so the other phone stops showing it', async () => {
    // The failure spec 7.9 exists for: delete the association rows only and
    // the other device keeps a tag that no longer exists, for ever, with no
    // symptom at all.
    const tag = await makeTag('night');
    const first = await tagged([tag.id]);
    const second = await tagged([tag.id], 3);

    const before = (await since(0)).nextRev;
    await remove(tag.id);

    const feed = await since(before);
    expect(feed.events.map((one) => one.id).sort()).toEqual([first.id, second.id].sort());
    // And they arrive without the tag on them.
    for (const one of feed.events) expect(one.tagIds).toEqual([]);
  });

  it('gives every moved event a rev of its own here too', async () => {
    const tag = await makeTag('night');
    for (let i = 0; i < 4; i += 1) await tagged([tag.id], i + 1);

    const before = (await since(0)).nextRev;
    await remove(tag.id);

    const revs = (await since(before)).events.map((one) => one.rev);
    expect(revs).toHaveLength(4);
    expect(new Set(revs).size).toBe(4);
  });

  it('leaves an event that never had the tag alone', async () => {
    const tag = await makeTag('night');
    const other = await makeTag('day');
    await tagged([tag.id]);
    const elsewhere = await tagged([other.id], 4);

    const before = (await since(0)).nextRev;
    await remove(tag.id);

    expect((await since(before)).events.map((one) => one.id)).not.toContain(elsewhere.id);
    expect((await listTags()).map((one) => one.name)).toEqual(['day']);
  });

  it('deletes a tag nobody used without touching anything', async () => {
    const tag = await makeTag('night');
    const event = await tagged([]);

    const before = (await since(0)).nextRev;
    expect((await remove(tag.id)).status).toBe(204);

    expect((await since(before)).events).toEqual([]);
    expect((await request(`/api/events/${event.id}`, {}, token)).status).toBe(200);
  });
});

describe('two parents at the same moment', () => {
  it('answers the loser of a name race, rather than failing', async () => {
    // The check before the write is not a lock: both requests read the tag
    // list, both see the name free, and one of them then meets
    // `UNIQUE(baby_id, name)`. Reported from review as a 500.
    const night = await makeTag('night');
    const day = await makeTag('day');

    const [a, b] = await Promise.all([rename(night.id, 'same'), rename(day.id, 'same')]);
    const codes = [a.status, b.status].sort();

    expect(codes).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await json<{ error: { code: string } }>(loser))
      .toMatchObject({ error: { code: 'TAG_NAME_TAKEN' } });

    // Exactly one of them took the name, and the other kept its own.
    const names = (await listTags()).map((one) => one.name).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain('same');
  });

  it('leaves the loser\u2019s events exactly as they were', async () => {
    // **The batch rollback, for real.** A failure part way through is
    // reachable after all: the loser's rev bump runs before the rename that
    // fails, so if D1 did not unwind it, its events would carry new revs
    // for a rename that never happened -- and the other phone would sync a
    // change that does not exist.
    const night = await makeTag('night');
    const day = await makeTag('day');
    const onNight = await tagged([night.id]);
    const onDay = await tagged([day.id], 3);

    const before = await since(0);
    const was = new Map(before.events.map((one) => [one.id, one]));

    const [a] = await Promise.all([rename(night.id, 'same'), rename(day.id, 'same')]);
    const loserIsNight = a.status === 409;
    const untouched = loserIsNight ? onNight : onDay;
    const moved = loserIsNight ? onDay : onNight;

    const feed = await since(before.nextRev);
    expect(feed.events.map((one) => one.id)).toEqual([moved.id]);

    // And the loser's event is byte for byte where it was.
    const still = await json<StoredEvent>(
      await request(`/api/events/${untouched.id}`, {}, token),
    );
    expect(still.rev).toBe(was.get(untouched.id)?.rev);
    expect(still.updatedAt).toBe(was.get(untouched.id)?.updatedAt);
  });

  it('does not report a rename of a tag that has just been deleted', async () => {
    // The read finds the tag, the other phone deletes it, and the update
    // then matches nothing. Answering 200 with the row read earlier reports
    // a change that did not happen, to a tag that no longer exists.
    const tag = await makeTag('night');
    await tagged([tag.id]);

    const [renamed, removed] = await Promise.all([rename(tag.id, 'nights'), remove(tag.id)]);

    expect(removed.status).toBe(204);
    expect(renamed.status).toBe(404);
    expect(await listTags()).toEqual([]);

    // Which of the two guards answered is worth being straight about: in
    // this runtime the delete settles before the rename reads, so the read
    // is what returns 404 and the `meta.changes` check behind it is never
    // reached. That check is for the interleaving a real deployment can
    // produce and this harness cannot; it is covered on the delete path,
    // which has no read in front of it.
  });
});

describe('the three effects of a delete are one write', () => {
  it('leaves no state where one of them happened and another did not', async () => {
    // Deleting a tag is three things -- move the revs, drop the
    // associations, drop the tag -- and spec 4.3 requires all or none.
    //
    // **What this asserts is the joint outcome.** The rollback itself is
    // exercised by the name race above, where the loser's rev bump runs and
    // then its rename fails; what is checked here is that no two of these
    // three are ever seen apart.
    const tag = await makeTag('night');
    const first = await tagged([tag.id]);
    const second = await tagged([tag.id], 3);

    const before = (await since(0)).nextRev;
    expect((await remove(tag.id)).status).toBe(204);

    // The tag is gone...
    expect(await listTags()).toEqual([]);

    // ...and so is every association, read back off the events themselves...
    for (const one of [first, second]) {
      const response = await request(`/api/events/${one.id}`, {}, token);
      expect((await json<StoredEvent>(response)).tagIds).toEqual([]);
    }

    // ...and both events moved, so the other phone will be told.
    const moved = (await since(before)).events;
    expect(moved.map((one) => one.id).sort()).toEqual([first.id, second.id].sort());
    for (const one of moved) expect(one.rev).toBeGreaterThan(before);
  });

  it('keeps the tag id across a rename, so events keep pointing at it', async () => {
    // A rename that minted a new id would orphan every association and be
    // a delete wearing a rename's clothes.
    const tag = await makeTag('night');
    const event = await tagged([tag.id]);

    await rename(tag.id, 'nights');

    expect((await listTags())[0]).toMatchObject({ id: tag.id, name: 'nights' });
    const response = await request(`/api/events/${event.id}`, {}, token);
    expect((await json<StoredEvent>(response)).tagIds).toEqual([tag.id]);
  });
});

describe('who may write to a tag', () => {
  it('refuses a stranger, and says the tag does not exist', async () => {
    // 404 rather than 403: confirming that an id exists is itself something
    // a stranger should not learn (spec 6.4).
    const tag = await makeTag('night');
    const stranger = await signedInUser('stranger', 'another-long-password');

    expect((await rename(tag.id, 'nights', stranger.token)).status).toBe(404);
    expect((await remove(tag.id, stranger.token)).status).toBe(404);
    expect((await listTags())[0]?.name).toBe('night');
  });

  it('refuses a tag belonging to another baby, even from its owner', async () => {
    // The path names one baby and the tag belongs to another. Taking the
    // tag id on its own would let a valid id reach across families.
    const mine = await makeTag('night');
    const otherBaby = await createBaby(token, { nickname: 'Second', birthDate: '2026-03-08' });

    expect((await rename(mine.id, 'nights', token, otherBaby)).status).toBe(404);
    expect((await remove(mine.id, token, otherBaby)).status).toBe(404);
    expect((await listTags())[0]?.name).toBe('night');
  });

  it('refuses without a session at all', async () => {
    const tag = await makeTag('night');
    const response = await request(
      `/api/babies/${babyId}/tags/${tag.id}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(401);
  });

  it('answers 404 for a tag id that was never real', async () => {
    expect((await rename(crypto.randomUUID(), 'nights')).status).toBe(404);
    expect((await remove(crypto.randomUUID())).status).toBe(404);
  });
});
