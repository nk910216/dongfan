import { beforeEach, describe, expect, it } from 'vitest';
import type { TaggedEventsDto } from '@dongfan/shared';
import { createBaby, createEvent, createTag, deleteEvent, json, newId, request, signedInUser } from './helpers.js';
import type { StoredEvent } from './helpers.js';

/**
 * The tag page's filter: `GET /events?tags=` (spec 7.9).
 *
 * The failures this file is about all look like a working list. A record
 * carrying two of the chosen tags shown twice, a page that comes up one
 * short, two records recorded in the same second each landing on both
 * pages or on neither -- every response is a 200 with plausible rows in it.
 * So the paging tests walk **every** page and compare the union with what
 * was written, rather than looking at the first one.
 *
 * Days are named rather than counted back from now, because the range is
 * on `local_date` and a relative offset changes day around midnight.
 */

const MINUTE = 60_000;
/** Noon in Taipei on a named day, well clear of either midnight. */
const noonOn = (day: number): number => Date.UTC(2026, 8, day, 4, 0);

let token: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser();
  token = user.token;
  babyId = await createBaby(token, { birthDate: '2026-03-08' });
});

function filter(query: string, as = token, baby = babyId): Promise<Response> {
  return request(`/api/babies/${baby}/events?${query}`, {}, as);
}

async function page(query: string): Promise<TaggedEventsDto> {
  const response = await filter(query);
  expect(response.status).toBe(200);
  return json<TaggedEventsDto>(response);
}

async function record(tagIds: string[], startedAt: number, baby = babyId): Promise<StoredEvent> {
  return createEvent(token, baby, {
    id: newId(),
    typeId: 'diaper',
    intent: 'record',
    startedAt,
    metadata: { diaper_kind: 'pee' },
    tagIds,
  });
}

/** Every page, in order, until the server says there is no more. */
async function walk(query: string, limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let pages = 0;
  for (let offset = 0; ; offset += limit) {
    const body = await page(`${query}&limit=${limit}&offset=${offset}`);
    pages += 1;
    ids.push(...body.events.map((event) => event.id));
    if (!body.hasMore) return { ids, pages };
    // A loop that never ends is a failure, not a hang.
    expect(pages).toBeLessThan(50);
  }
}

describe('which records a tag finds', () => {
  it('finds a record carrying any of the chosen tags, and each one once', async () => {
    const night = await createTag(token, babyId, 'night');
    const fussy = await createTag(token, babyId, 'fussy');
    const other = await createTag(token, babyId, 'other');

    const onlyNight = await record([night], noonOn(10));
    const onlyFussy = await record([fussy], noonOn(11));
    // Joins twice -- once per chosen tag -- and must come back once.
    const both = await record([night, fussy], noonOn(12));
    await record([other], noonOn(13));
    await record([], noonOn(14));

    const body = await page(`tags=${night},${fussy}`);

    expect(body.events.map((event) => event.id)).toEqual([both.id, onlyFussy.id, onlyNight.id]);
    expect(body.total).toBe(3);
    expect(body.hasMore).toBe(false);
  });

  it('returns every tag a record carries, not only the ones asked about', async () => {
    // The page is about the record. Showing it with only the matching tags
    // would say it had lost the others.
    const night = await createTag(token, babyId, 'night');
    const fussy = await createTag(token, babyId, 'fussy');
    const event = await record([night, fussy], noonOn(10));

    const body = await page(`tags=${night}`);

    expect(body.events[0]?.id).toBe(event.id);
    expect(body.events[0]?.tagIds).toEqual([night, fussy].sort());
  });

  it('leaves out a deleted record', async () => {
    const night = await createTag(token, babyId, 'night');
    const kept = await record([night], noonOn(10));
    const gone = await record([night], noonOn(11));
    expect((await deleteEvent(token, gone.id, gone.version)).status).toBe(200);

    const body = await page(`tags=${night}`);

    expect(body.events.map((event) => event.id)).toEqual([kept.id]);
    expect(body.total).toBe(1);
  });

  it('finds nothing for a tag that has been deleted, and the records stay', async () => {
    const night = await createTag(token, babyId, 'night');
    const event = await record([night], noonOn(10));
    expect((await request(`/api/babies/${babyId}/tags/${night}`, { method: 'DELETE' }, token)).status)
      .toBe(204);

    expect((await page(`tags=${night}`)).total).toBe(0);
    const still = await json<StoredEvent>(await request(`/api/events/${event.id}`, {}, token));
    expect(still.tagIds).toEqual([]);
  });

  it('still finds the records under a tag that was renamed', async () => {
    // The id is what is filtered on, so a rename moves nothing in or out.
    const night = await createTag(token, babyId, 'night');
    const event = await record([night], noonOn(10));
    expect((await request(
      `/api/babies/${babyId}/tags/${night}`,
      { method: 'PATCH', body: JSON.stringify({ name: 'nights' }) },
      token,
    )).status).toBe(200);

    expect((await page(`tags=${night}`)).events.map((one) => one.id)).toEqual([event.id]);
  });
});

describe('the order and the range', () => {
  it('is newest first unless asked otherwise', async () => {
    const night = await createTag(token, babyId, 'night');
    const first = await record([night], noonOn(10));
    const second = await record([night], noonOn(11));

    expect((await page(`tags=${night}`)).events.map((one) => one.id)).toEqual([second.id, first.id]);
    expect((await page(`tags=${night}&sort=oldest`)).events.map((one) => one.id))
      .toEqual([first.id, second.id]);
  });

  it('keeps a range closed at both ends, on the local date', async () => {
    const night = await createTag(token, babyId, 'night');
    await record([night], noonOn(9));
    const from = await record([night], noonOn(10));
    const to = await record([night], noonOn(12));
    await record([night], noonOn(13));

    const body = await page(`tags=${night}&from=2026-09-10&to=2026-09-12&sort=oldest`);

    expect(body.events.map((one) => one.id)).toEqual([from.id, to.id]);
    expect(body.total).toBe(2);
  });

  it('takes either end alone', async () => {
    const night = await createTag(token, babyId, 'night');
    const early = await record([night], noonOn(9));
    const late = await record([night], noonOn(13));

    expect((await page(`tags=${night}&from=2026-09-10`)).events.map((one) => one.id)).toEqual([late.id]);
    expect((await page(`tags=${night}&to=2026-09-10`)).events.map((one) => one.id)).toEqual([early.id]);
  });
});

describe('paging', () => {
  it('hands out every record exactly once across pages, with two tags matching some of them', async () => {
    // The shape that breaks paging over a join: half the records carry
    // both chosen tags. Counted before DISTINCT, they take two slots each,
    // the pages come up short and the next one starts too late.
    const night = await createTag(token, babyId, 'night');
    const fussy = await createTag(token, babyId, 'fussy');
    const written: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      const tags = i % 2 === 0 ? [night, fussy] : i % 3 === 0 ? [fussy] : [night];
      written.push((await record(tags, noonOn(10) + i * 10 * MINUTE)).id);
    }

    for (const sort of ['recent', 'oldest']) {
      const { ids, pages } = await walk(`tags=${night},${fussy}&sort=${sort}`, 2);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...written].sort());
      expect(pages).toBe(5);
    }
  });

  it('does not lose or repeat records that share a start time across a page boundary', async () => {
    // Two nappies recorded in the same second are ordinary. Ordered by the
    // time alone, ties may fall either side of a boundary on two reads.
    const night = await createTag(token, babyId, 'night');
    const at = noonOn(10);
    const written: string[] = [];
    for (let i = 0; i < 7; i += 1) written.push((await record([night], at)).id);

    for (const sort of ['recent', 'oldest']) {
      const { ids } = await walk(`tags=${night}&sort=${sort}`, 3);
      expect(ids).toHaveLength(7);
      expect([...ids].sort()).toEqual([...written].sort());
      // The tiebreak is the id, in the same direction as the sort.
      expect(ids).toEqual(sort === 'oldest' ? [...written].sort() : [...written].sort().reverse());
    }
  });

  it('says how many there are, and whether there are more, from the same read', async () => {
    const night = await createTag(token, babyId, 'night');
    for (let i = 0; i < 5; i += 1) await record([night], noonOn(10) + i * MINUTE);

    const first = await page(`tags=${night}&limit=2`);
    expect(first).toMatchObject({ total: 5, hasMore: true });
    expect(first.events).toHaveLength(2);

    const last = await page(`tags=${night}&limit=2&offset=4`);
    expect(last).toMatchObject({ total: 5, hasMore: false });
    expect(last.events).toHaveLength(1);

    // A last page that is exactly full is the case "a full page means there
    // is more" gets wrong, and it costs the client a fetch for nothing.
    const exact = await page(`tags=${night}&limit=5`);
    expect(exact).toMatchObject({ total: 5, hasMore: false });

    const past = await page(`tags=${night}&limit=2&offset=10`);
    expect(past).toMatchObject({ total: 5, hasMore: false, events: [] });
  });

  it('defaults to fifty a page and refuses more than two hundred', async () => {
    const night = await createTag(token, babyId, 'night');
    for (let i = 0; i < 51; i += 1) await record([night], noonOn(10) + i * MINUTE);

    const body = await page(`tags=${night}`);
    expect(body.events).toHaveLength(50);
    expect(body).toMatchObject({ total: 51, hasMore: true });

    expect((await filter(`tags=${night}&limit=200`)).status).toBe(200);
    expect((await filter(`tags=${night}&limit=201`)).status).toBe(422);
  });

  it('takes a hundred tags in one request, which a bound list could not', async () => {
    // D1 allows a hundred bound parameters a statement. A hundred ids
    // bound one by one, plus the baby and the paging, is over it; one JSON
    // array is one parameter however long it is (spec 4.2).
    const night = await createTag(token, babyId, 'night');
    const event = await record([night], noonOn(10));
    const unknown = Array.from({ length: 99 }, () => crypto.randomUUID());

    const body = await page(`tags=${[night, ...unknown].join(',')}&from=2026-09-01&to=2026-09-30`);

    expect(body.events.map((one) => one.id)).toEqual([event.id]);
  });
});

describe('whose records a filter can reach', () => {
  it('finds nothing through a tag belonging to another baby', async () => {
    const other = await createBaby(token, { nickname: 'Second', birthDate: '2026-03-08' });
    const theirs = await createTag(token, other, 'night');
    await record([theirs], noonOn(10), other);

    const body = await page(`tags=${theirs}`);

    expect(body).toMatchObject({ total: 0, events: [] });
  });

  it('refuses a stranger, and says the baby does not exist', async () => {
    const night = await createTag(token, babyId, 'night');
    await record([night], noonOn(10));
    const stranger = await signedInUser('stranger', 'another-long-password');

    expect((await filter(`tags=${night}`, stranger.token)).status).toBe(404);
  });

  it('refuses a request with no session', async () => {
    const night = await createTag(token, babyId, 'night');
    expect((await request(`/api/babies/${babyId}/events?tags=${night}`)).status).toBe(401);
  });
});

describe('what a filter refuses', () => {
  it.each([
    ['an empty tag list', 'tags='],
    ['a tag id that is not one', 'tags=night'],
    ['a range that runs backwards', 'tags=$T&from=2026-09-12&to=2026-09-10'],
    ['a date that does not parse', 'tags=$T&from=invalid'],
    ['a sort it does not know', 'tags=$T&sort=random'],
    ['a negative offset', 'tags=$T&offset=-1'],
    ['a sync cursor alongside it', 'tags=$T&since=0'],
  ])('refuses %s', async (_name, query) => {
    const night = await createTag(token, babyId, 'night');
    const response = await filter(query.replace('$T', night));
    expect(response.status).toBe(422);
    const body = await json<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('leaves the incremental sync as it was when no tags are asked about', async () => {
    const night = await createTag(token, babyId, 'night');
    await record([night], noonOn(10));

    const body = await json<{ events: StoredEvent[]; nextRev: number; hasMore: boolean }>(
      await filter('since=0'),
    );
    expect(body.events).toHaveLength(1);
    expect(body.nextRev).toBeGreaterThan(0);
  });
});
