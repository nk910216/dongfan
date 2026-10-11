import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportDto } from '@dongfan/shared';
import { EXPORT_MAX_PAGES, EXPORT_PAGE_SIZE, exportBaby } from '../src/lib/export.js';
import { MAX_QUERIES_PER_REQUEST, counting, fetchCounting } from './query-count.js';
import {
  createBaby, createEvent, createTag, deleteEvent, newId, request, signedInUser,
} from './helpers.js';
import { USER_CONTENT } from './fixtures/user-content.js';

/**
 * The export (spec 5.9).
 *
 * Its failures are files that look complete: the first page only, a
 * record repeated where two pages met, another family's records, a hash
 * that should never have left the database. So the tests read the whole
 * document and compare it with what was written.
 *
 * Every record is invented, written to a database created for this run.
 */

const HOUR = 3_600_000;

let token: string;
let userId: string;
let babyId: string;

beforeEach(async () => {
  const user = await signedInUser(`export-${crypto.randomUUID().slice(0, 8)}`, 'a-long-random-password');
  token = user.token;
  userId = user.id;
  babyId = await createBaby(token, { nickname: USER_CONTENT.nickname, birthDate: '2026-03-08' });
});

async function exported(as = token, baby = babyId): Promise<{ response: Response; body: ExportDto; text: string }> {
  const response = await request(`/api/babies/${baby}/export`, {}, as);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { response, body: JSON.parse(text) as ExportDto, text };
}

/** Rows straight into the table, for volumes the API's daily breaker would stop (spec 5.7). */
/** Revs handed out so far, so two seeds in one test never share one (spec 5.4's unique index). */
let seeded = 0;

async function seed(count: number, startedAt: (i: number) => number, baby = babyId): Promise<void> {
  const statements: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = startedAt(i);
    const date = new Date(at + 8 * HOUR).toISOString().slice(0, 10);
    statements.push(`INSERT INTO events (id, baby_id, type_id, created_by, created_at, updated_at, started_at, ended_at, local_date, value, note, metadata, version, rev, active, deleted_at) VALUES ('${crypto.randomUUID()}', '${baby}', 'diaper', '${userId}', ${at}, ${at}, ${at}, NULL, '${date}', 1, '', '{}', 1, ${2_000_000 + seeded + i}, NULL, NULL);`);
  }
  seeded += count;
  // In slices: one exec of thousands of statements is slow to parse.
  for (let i = 0; i < statements.length; i += 500) {
    await env.DB.exec(statements.slice(i, i + 500).join('\n'));
  }
}

describe('what is in it', () => {
  it('has every live record, with its tags, and the baby and the tags themselves', async () => {
    const night = await createTag(token, babyId, USER_CONTENT.tagName);
    const day = await createTag(token, babyId, 'daytime');
    const startedAt = Date.now() - 3 * HOUR;
    const feed = await createEvent(token, babyId, {
      id: newId(), typeId: 'bottle', intent: 'record', startedAt, value: 120,
      note: USER_CONTENT.noteWithEmoji, tagIds: [night, day],
    });
    const nappy = await createEvent(token, babyId, {
      id: newId(), typeId: 'diaper', intent: 'record', startedAt: startedAt + HOUR,
      metadata: { diaper_kind: 'pee' },
    });

    const { body } = await exported();

    expect(body.format).toBe('dongfan-export');
    expect(body.formatVersion).toBe(1);
    expect(body.baby).toEqual({
      id: babyId, nickname: USER_CONTENT.nickname, gender: 'other', birthDate: '2026-03-08', timezone: 'Asia/Taipei',
    });
    expect(body.tags.map((tag) => tag.name).sort()).toEqual([USER_CONTENT.tagName, 'daytime'].sort());
    expect(body.eventCount).toBe(2);
    expect(body.events.map((event) => event.id)).toEqual([feed.id, nappy.id]);

    const first = body.events[0];
    expect(first).toEqual({
      id: feed.id,
      typeId: 'bottle',
      startedAt,
      endedAt: null,
      localDate: feed.localDate,
      value: 120,
      // User content, byte for byte (spec 13.1.1).
      note: USER_CONTENT.noteWithEmoji,
      metadata: {},
      active: false,
      tagIds: [night, day].sort(),
      createdBy: userId,
      createdAt: feed.createdAt,
      updatedAt: feed.updatedAt,
    });
    expect(body.events[1]?.metadata).toEqual({ diaper_kind: 'pee' });
  });

  it('says how each type reads its stored values', async () => {
    const { body } = await exported();
    // 365 stored is 36.5 degrees; without the scale the file says 365.
    expect(body.types['temperature']).toEqual({ unit: '°C', scale: 10, aggregation: 'max' });
    expect(body.types['sleep']).toEqual({ unit: null, scale: null, aggregation: 'duration_sum' });
  });

  it('marks a running timer, which has no end yet', async () => {
    await createEvent(token, babyId, {
      id: newId(), typeId: 'sleep', intent: 'start_timer', startedAt: Date.now() - HOUR, endedAt: null,
    });
    const { body } = await exported();
    expect(body.events[0]).toMatchObject({ active: true, endedAt: null });
  });

  it('leaves out deleted records', async () => {
    const kept = await createEvent(token, babyId, { id: newId(), typeId: 'diaper', intent: 'record', startedAt: Date.now() - 2 * HOUR });
    const gone = await createEvent(token, babyId, { id: newId(), typeId: 'diaper', intent: 'record', startedAt: Date.now() - HOUR });
    expect((await deleteEvent(token, gone.id, gone.version)).status).toBe(200);

    const { body } = await exported();
    expect(body.events.map((event) => event.id)).toEqual([kept.id]);
    expect(body.eventCount).toBe(1);
  });

  it('carries nothing that is not the family’s records', async () => {
    // Exact key sets, so a column added to a query later is a decision and
    // not an accident: a password hash or an invite code in a file somebody
    // emails to themselves is the failure this guards.
    await createTag(token, babyId, 'night');
    await createEvent(token, babyId, { id: newId(), typeId: 'diaper', intent: 'record', startedAt: Date.now() - HOUR });
    await request(`/api/babies/${babyId}/invite`, { method: 'POST' }, token);

    const { body, text } = await exported();
    expect(Object.keys(body).sort()).toEqual(
      ['baby', 'eventCount', 'events', 'exportedAt', 'format', 'formatVersion', 'tags', 'types'],
    );
    expect(Object.keys(body.baby).sort()).toEqual(['birthDate', 'gender', 'id', 'nickname', 'timezone']);
    expect(Object.keys(body.events[0] ?? {}).sort()).toEqual([
      'active', 'createdAt', 'createdBy', 'endedAt', 'id', 'localDate', 'metadata', 'note',
      'startedAt', 'tagIds', 'typeId', 'updatedAt', 'value',
    ]);
    expect(Object.keys(body.tags[0] ?? {}).sort()).toEqual(['createdAt', 'id', 'name']);

    for (const secret of ['password', 'hash', 'session', 'invite', 'code', 'rev', 'version', 'deleted']) {
      expect(text.toLowerCase()).not.toContain(`"${secret}`);
    }
  });

  it('is handed over as a download nothing caches', async () => {
    const { response } = await exported();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="dongfan-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('all of it, and once', () => {
  it('reads every page, not the first, with nothing repeated where pages meet', async () => {
    // Two and a quarter pages. The first page alone would be 2000; a seam
    // read twice or skipped would change the count or the set.
    const total = EXPORT_PAGE_SIZE * 2 + 500;
    const base = Date.UTC(2026, 3, 1);
    await seed(total, (i) => base + i * 60_000);

    const { body } = await exported();

    expect(body.eventCount).toBe(total);
    expect(body.events).toHaveLength(total);
    expect(new Set(body.events.map((event) => event.id)).size).toBe(total);
    const times = body.events.map((event) => event.startedAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('keeps records sharing a start time in one order across a seam', async () => {
    // Ties at the boundary are where an order that is not total repeats or
    // drops a row. The id breaks them.
    const at = Date.UTC(2026, 3, 1);
    await seed(5, () => at);
    const result = await exportBaby(env.DB, babyId, 'Asia/Taipei', { pageSize: 2, maxPages: 10 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    const ids = (JSON.parse(result.body) as ExportDto).events.map((event) => event.id);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([...ids].sort());
  });

  it('refuses past its limit rather than handing over the part that fits', async () => {
    // A truncated export looks exactly like a complete one. Tested with a
    // small page so the limit can be reached without fifty thousand rows.
    await seed(4, (i) => Date.UTC(2026, 3, 1) + i * 60_000);

    const fits = await exportBaby(env.DB, babyId, 'Asia/Taipei', { pageSize: 2, maxPages: 3 });
    expect(fits.kind).toBe('ok');

    const over = await exportBaby(env.DB, babyId, 'Asia/Taipei', { pageSize: 2, maxPages: 2 });
    expect(over).toEqual({ kind: 'too_large', eventCount: 4 });
  });

  /**
   * The database with somebody writing between the export's count and its
   * read: the other phone recording a nappy at the wrong moment.
   */
  function writingBeforeTheRead(rows: number): D1Database {
    return new Proxy(env.DB, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await seed(rows, (i) => Date.UTC(2026, 5, 1) + i * 60_000);
            return target.batch(statements);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  it('takes in a record written between counting and reading', async () => {
    // Two rows on pages of two is one page plus the spare: room for two
    // more. One more arrives, and the file has all three.
    await seed(2, (i) => Date.UTC(2026, 3, 1) + i * 60_000);
    const result = await exportBaby(writingBeforeTheRead(1), babyId, 'Asia/Taipei', { pageSize: 2, maxPages: 10 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect((JSON.parse(result.body) as ExportDto).events).toHaveLength(3);
    expect(result.eventCount).toBe(3);
  });

  it('refuses rather than hand over a short file when more arrived than it left room for', async () => {
    // Three more than room for two: the pages hold four of five. Without
    // the check against the count read in the same transaction, that is a
    // file one record short that looks complete.
    await seed(2, (i) => Date.UTC(2026, 3, 1) + i * 60_000);
    const result = await exportBaby(writingBeforeTheRead(3), babyId, 'Asia/Taipei', { pageSize: 2, maxPages: 10 });
    expect(result).toEqual({ kind: 'moved' });
  });

  it('stays inside the query budget at the most pages it will read', async () => {
    // Pages are statements, and statements are budgeted: thirty a request
    // here, fifty on the free plan (spec 11.2). Counted for real at the
    // ceiling -- one-row pages, so the ceiling is reachable without fifty
    // thousand rows -- together with what the route spends before the
    // handler runs.
    await seed(EXPORT_MAX_PAGES - 1, (i) => Date.UTC(2026, 3, 1) + i * 60_000);
    const handler = { count: 0 };
    const result = await exportBaby(counting(env.DB, handler), babyId, 'Asia/Taipei', {
      pageSize: 1, maxPages: EXPORT_MAX_PAGES,
    });
    expect(result.kind).toBe('ok');

    // The same rows through the route, at the default page size: the count,
    // the baby, the tags, the second count and one page are five; the rest
    // is the session and the permission check.
    const { queries: routeTotal } = await fetchCounting(`/api/babies/${babyId}/export`, {}, token);
    const beforeHandler = routeTotal - 5;
    expect(beforeHandler).toBeGreaterThan(0);
    expect(handler.count).toBe(4 + EXPORT_MAX_PAGES);
    expect(handler.count + beforeHandler).toBeLessThanOrEqual(MAX_QUERIES_PER_REQUEST);
  });
});

describe('whose it is', () => {
  it('has none of another baby’s records or tags', async () => {
    const other = await createBaby(token, { nickname: 'Second', birthDate: '2026-03-08' });
    await createTag(token, other, 'theirs');
    await createEvent(token, other, { id: newId(), typeId: 'diaper', intent: 'record', startedAt: Date.now() - HOUR });
    const mine = await createEvent(token, babyId, { id: newId(), typeId: 'diaper', intent: 'record', startedAt: Date.now() - HOUR });

    const { body } = await exported();
    expect(body.events.map((event) => event.id)).toEqual([mine.id]);
    expect(body.tags).toEqual([]);
  });

  it('refuses a stranger, and says the baby does not exist', async () => {
    const stranger = await signedInUser('stranger', 'another-long-password');
    const response = await request(`/api/babies/${babyId}/export`, {}, stranger.token);
    expect(response.status).toBe(404);
  });

  it('refuses a request with no session', async () => {
    expect((await request(`/api/babies/${babyId}/export`)).status).toBe(401);
  });
});
