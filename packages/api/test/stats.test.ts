import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_EVENT_DURATION_MS, MAX_STATS_DAYS, addLocalDays, daysBetween, startOfLocalDay,
} from '@dongfan/shared';
import type { StatsDto } from '@dongfan/shared';
import { createBaby, createEvent, deleteEvent, json, request, signedInUser } from './helpers.js';
import { MAX_QUERIES_PER_REQUEST, enforceBudget, requestCounting } from './query-count.js';

/**
 * `GET /babies/:id/stats` (spec 5.6, 7.7).
 *
 * Every mistake available here is quiet. A zero filled in where no value was
 * recorded drops a growth curve to the floor; a zero left out where nothing
 * happened makes a week of no feeds look like a week nobody charted; an
 * aggregation applied to the wrong type adds up three weights and reports a
 * toddler at nine kilos. None of it throws, and all of it looks like a
 * chart.
 */

const TZ = 'Asia/Taipei';

/** A named day, so no test depends on what time it is run. */
const DAY = '2026-06-15';
const at = (date: string, hour: number, minute = 0): number =>
  startOfLocalDay(date, TZ) + hour * 3_600_000 + minute * 60_000;

let token: string;
let userId: string;
let babyId: string;

beforeEach(async () => {
  // A fresh account per test, because the suite shares one database.
  const unique = crypto.randomUUID();
  const user = await signedInUser(`stats-${unique}`, 'a-long-random-password');
  token = user.token;
  userId = user.id;
  babyId = await createBaby(token, { birthDate: '2026-01-01' });
});

function statsUrl(types: string, from: string, to: string): string {
  return `/api/babies/${babyId}/stats?types=${types}&from=${from}&to=${to}`;
}

async function stats(types: string, from: string, to: string): Promise<StatsDto> {
  const response = await request(statsUrl(types, from, to), {}, token);
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
  }
  return json<StatsDto>(response);
}

function series(body: StatsDto, typeId: string): { date: string; value: number }[] {
  const found = body.series.find((s) => s.typeId === typeId);
  if (!found) throw new Error(`No series for ${typeId}`);
  return found.points;
}

/**
 * Rows written straight into the table.
 *
 * A fixture, not the thing under test: going through the API would mean
 * thousands of POSTs and would run into the 500-a-day circuit breaker
 * (spec 5.7), which is about a runaway loop and not about a year of history.
 * The endpoint still reads them back through the real database.
 */
async function seed(
  rows: {
    typeId: string;
    startedAt: number;
    value?: number;
    /** Left out for a record with no end; `active` for a running timer. */
    endedAt?: number;
    active?: boolean;
    deletedAt?: number;
    baby?: string;
  }[],
): Promise<void> {
  let rev = 1_000_000;
  const statements = rows.map((row) => {
    rev += 1;
    // The same rule the server applies: the local date comes from the start,
    // in the baby's timezone (spec 5.3). Written out here because a fixture
    // that disagreed with the server about which day an event is filed under
    // would make every assertion below meaningless.
    const date = new Date(row.startedAt + 8 * 3_600_000).toISOString().slice(0, 10);
    return `INSERT INTO events (id, baby_id, type_id, created_by, created_at, updated_at, started_at, ended_at, local_date, value, note, metadata, version, rev, active, deleted_at) VALUES ('${crypto.randomUUID()}', '${row.baby ?? babyId}', '${row.typeId}', '${userId}', ${row.startedAt}, ${row.startedAt}, ${row.startedAt}, ${row.endedAt ?? 'NULL'}, '${date}', ${row.value ?? 1}, '', '{}', 1, ${rev}, ${row.active ? 1 : 'NULL'}, ${row.deletedAt ?? 'NULL'});`;
  });
  await env.DB.exec(statements.join('\n'));
}

describe('who may ask', () => {
  it('refuses without a session', async () => {
    const response = await request(statsUrl('diaper', DAY, DAY));
    expect(response.status).toBe(401);
  });

  it('refuses another family’s baby, without confirming it exists', async () => {
    // 404 rather than 403, as `requireBabyAccess` decides for every route:
    // telling a stranger that an id exists is information in itself.
    const other = await signedInUser(`other-${crypto.randomUUID()}`, 'a-long-random-password');
    const response = await request(statsUrl('diaper', DAY, DAY), {}, other.token);
    expect(response.status).toBe(404);
  });

  it('counts only the baby that was asked about', async () => {
    const second = await createBaby(token, { nickname: 'Sibling' });
    await seed([
      { typeId: 'diaper', startedAt: at(DAY, 9), value: 1 },
      { typeId: 'diaper', startedAt: at(DAY, 10), value: 1, baby: second },
    ]);

    expect(series(await stats('diaper', DAY, DAY), 'diaper')).toEqual([{ date: DAY, value: 1 }]);
  });
});

describe('what it will not accept', () => {
  it('refuses a date that does not exist', async () => {
    const response = await request(statsUrl('diaper', '2026-02-31', DAY), {}, token);
    expect(response.status).toBe(422);
  });

  it('refuses a range that runs backwards', async () => {
    const response = await request(statsUrl('diaper', DAY, '2026-06-01'), {}, token);
    expect(response.status).toBe(422);
  });

  it('refuses a range wider than a year, which is what caps the response', async () => {
    // Spec 5.6 promises at most 366 points, and the only thing that can
    // keep that promise is refusing a wider range.
    //
    // The boundary is written out rather than derived from
    // `MAX_STATS_DAYS`. Computed from the constant, this test moves
    // whenever the constant moves and can never fail -- which is how the
    // first version of it was written, and raising the cap to 4000 left
    // it green.
    expect(MAX_STATS_DAYS).toBe(366);
    expect(daysBetween('2026-06-15', '2027-06-15')).toBe(366);
    expect(daysBetween('2026-06-15', '2027-06-16')).toBe(367);

    expect((await request(statsUrl('diaper', '2026-06-15', '2027-06-16'), {}, token)).status)
      .toBe(422);

    const widest = await request(statsUrl('diaper', '2026-06-15', '2027-06-15'), {}, token);
    expect(widest.status).toBe(200);

    // And the promise itself, not just the refusal that protects it.
    const body = await json<StatsDto>(widest);
    expect(series(body, 'diaper')).toHaveLength(366);
  });

  it('refuses a date that is not a date at all, rather than failing inside', async () => {
    // Not the same path as 2026-02-31, which parses perfectly and is merely
    // a day that does not exist. These do not parse, and the range check
    // used to run on them anyway: a failed `.refine` leaves the raw string
    // in place and Zod carries on, so `daysBetween` threw out of
    // `safeParse` and the route answered 500 to a plainly bad request.
    const malformed: [string, string][] = [
      ['invalid', '2026-06-16'],
      ['2026-06-15', 'nope'],
      ['2026-6-15', '2026-06-16'],
      ['', '2026-06-16'],
      ['2026-06-15', ''],
      ['15-06-2026', '2026-06-16'],
    ];

    for (const [from, to] of malformed) {
      const response = await request(statsUrl('diaper', from, to), {}, token);
      expect(response.status, `from=${from} to=${to}`).toBe(422);
    }
  });

  it('refuses a type it has never heard of', async () => {
    const response = await request(statsUrl('not_a_type', DAY, DAY), {}, token);
    expect(response.status).toBe(422);
  });

  it('refuses an empty list rather than answering about nothing', async () => {
    const response = await request(statsUrl('', DAY, DAY), {}, token);
    expect(response.status).toBe(422);
  });

});

describe('adding up a day', () => {
  it('counts the events of each day and carries a zero for the days between', async () => {
    // A day with no nappies really had no nappies, so the zero is a fact
    // and not a gap (spec 7.7).
    await seed([
      { typeId: 'diaper', startedAt: at('2026-06-15', 8), value: 1 },
      { typeId: 'diaper', startedAt: at('2026-06-15', 14), value: 1 },
      { typeId: 'diaper', startedAt: at('2026-06-17', 9), value: 1 },
    ]);

    expect(series(await stats('diaper', '2026-06-15', '2026-06-17'), 'diaper')).toEqual([
      { date: '2026-06-15', value: 2 },
      { date: '2026-06-16', value: 0 },
      { date: '2026-06-17', value: 1 },
    ]);
  });

  it('totals the amounts in stored units, zero-filled the same way', async () => {
    await seed([
      { typeId: 'bottle', startedAt: at('2026-06-15', 8), value: 120 },
      { typeId: 'bottle', startedAt: at('2026-06-15', 12), value: 90 },
      { typeId: 'bottle', startedAt: at('2026-06-16', 8), value: 100 },
    ]);

    const body = await stats('bottle', '2026-06-15', '2026-06-16');
    expect(series(body, 'bottle')).toEqual([
      { date: '2026-06-15', value: 210 },
      { date: '2026-06-16', value: 100 },
    ]);
    expect(body.series[0]?.unit).toBe('ml');
    expect(body.series[0]?.aggregation).toBe('sum');
  });

  it('takes the highest temperature of the day, not their total', async () => {
    await seed([
      { typeId: 'temperature', startedAt: at(DAY, 8), value: 367 },
      { typeId: 'temperature', startedAt: at(DAY, 20), value: 382 },
    ]);

    expect(series(await stats('temperature', DAY, DAY), 'temperature'))
      .toEqual([{ date: DAY, value: 382 }]);
  });

  it('takes the last weight of the day and leaves the other days alone', async () => {
    // Adding weights together reports a toddler at nine kilos; filling the
    // days between with zero drops the curve to the floor. Neither throws.
    await seed([
      { typeId: 'weight', startedAt: at('2026-06-15', 9), value: 7200 },
      { typeId: 'weight', startedAt: at('2026-06-15', 18), value: 7250 },
      { typeId: 'weight', startedAt: at('2026-06-22', 9), value: 7400 },
    ]);

    expect(series(await stats('weight', '2026-06-15', '2026-06-22'), 'weight')).toEqual([
      { date: '2026-06-15', value: 7250 },
      { date: '2026-06-22', value: 7400 },
    ]);
  });

  it('answers with an empty series rather than an error when nothing was recorded', async () => {
    const body = await stats('weight', '2026-06-15', '2026-06-22');
    expect(series(body, 'weight')).toEqual([]);
  });

  it('still carries the zeros when a counting type has nothing at all', async () => {
    expect(series(await stats('diaper', '2026-06-15', '2026-06-17'), 'diaper')).toEqual([
      { date: '2026-06-15', value: 0 },
      { date: '2026-06-16', value: 0 },
      { date: '2026-06-17', value: 0 },
    ]);
  });

  it('leaves out an event that was deleted', async () => {
    const event = await createEvent(token, babyId, {
      typeId: 'diaper',
      intent: 'record',
      startedAt: at(DAY, 9),
    });
    expect(series(await stats('diaper', DAY, DAY), 'diaper')).toEqual([{ date: DAY, value: 1 }]);

    expect((await deleteEvent(token, event.id, event.version)).status).toBe(200);

    expect(series(await stats('diaper', DAY, DAY), 'diaper')).toEqual([{ date: DAY, value: 0 }]);
  });

  it('answers about several types at once, in the order they were asked for', async () => {
    await seed([
      { typeId: 'bottle', startedAt: at(DAY, 8), value: 120 },
      { typeId: 'diaper', startedAt: at(DAY, 9), value: 1 },
    ]);

    const body = await stats('weight,bottle,diaper', DAY, DAY);
    expect(body.series.map((s) => s.typeId)).toEqual(['weight', 'bottle', 'diaper']);
    expect(body.from).toBe(DAY);
    expect(body.to).toBe(DAY);
  });
});

describe('time spent, split at midnight', () => {
  const MINUTE = 60_000;

  it('gives each day only the part of the night that fell in it', async () => {
    // 23:10 to 07:05. Counted on the 15th, but seven of its hours are the
    // 16th's, and putting all of it on either day shows one night at zero
    // and the next at sixteen (spec 3.4).
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-15', 23, 10),
      endedAt: at('2026-06-16', 7, 5),
    }]);

    expect(series(await stats('sleep', '2026-06-15', '2026-06-16'), 'sleep')).toEqual([
      { date: '2026-06-15', value: 50 },
      { date: '2026-06-16', value: 7 * 60 + 5 },
    ]);
  });

  it('is in minutes, and says so', async () => {
    await seed([{
      typeId: 'sleep',
      startedAt: at(DAY, 13),
      endedAt: at(DAY, 14, 30),
    }]);

    const body = await stats('sleep', DAY, DAY);
    expect(body.series[0]?.unit).toBe('min');
    expect(body.series[0]?.aggregation).toBe('duration_sum');
    expect(series(body, 'sleep')).toEqual([{ date: DAY, value: 90 }]);
  });

  it('rounds the day’s total once, not each nap', async () => {
    // Three naps of 40 seconds are two minutes, not zero. Rounding each one
    // first loses them all, and the error accumulates across a day of naps
    // (spec 5.3).
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 9), endedAt: at(DAY, 9) + 40_000 },
      { typeId: 'sleep', startedAt: at(DAY, 10), endedAt: at(DAY, 10) + 40_000 },
      { typeId: 'sleep', startedAt: at(DAY, 11), endedAt: at(DAY, 11) + 40_000 },
    ]);

    expect(series(await stats('sleep', DAY, DAY), 'sleep')).toEqual([{ date: DAY, value: 2 }]);
  });

  it('gives a night ending exactly at midnight entirely to the earlier day', async () => {
    // And no empty segment on the next one, which is what
    // `splitByLocalDate` does too -- the two have to agree or the chart and
    // the calendar disagree about the same night.
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-15', 23),
      endedAt: at('2026-06-16', 0),
    }]);

    expect(series(await stats('sleep', '2026-06-15', '2026-06-16'), 'sleep')).toEqual([
      { date: '2026-06-15', value: 60 },
      { date: '2026-06-16', value: 0 },
    ]);
  });

  it('gives a night starting exactly at midnight entirely to the new day', async () => {
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-16', 0),
      endedAt: at('2026-06-16', 0, 30),
    }]);

    expect(series(await stats('sleep', '2026-06-15', '2026-06-16'), 'sleep')).toEqual([
      { date: '2026-06-15', value: 0 },
      { date: '2026-06-16', value: 30 },
    ]);
  });

  it('splits the longest event there can be across exactly two days', async () => {
    // 24 hours is the limit, and it is the limit precisely so that one
    // midnight is the most anything can cross -- which is what makes two
    // parts enough (spec 3.4.1 rule 1).
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-15', 12),
      endedAt: at('2026-06-15', 12) + MAX_EVENT_DURATION_MS,
    }]);

    const points = series(await stats('sleep', '2026-06-15', '2026-06-17'), 'sleep');
    expect(points).toEqual([
      { date: '2026-06-15', value: 12 * 60 },
      { date: '2026-06-16', value: 12 * 60 },
      { date: '2026-06-17', value: 0 },
    ]);
    expect(points[0]!.value + points[1]!.value).toBe(MAX_EVENT_DURATION_MS / MINUTE);
  });

  it('finds the morning hours of a night that started before the range', async () => {
    // The whole reason the lower bound is widened by a day. Asked about the
    // 16th alone, this sleep is filed under the 15th and would be missed
    // entirely -- the 16th would lose seven hours without a word
    // (spec 3.4.1 rule 2).
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-15', 23, 10),
      endedAt: at('2026-06-16', 7, 5),
    }]);

    expect(series(await stats('sleep', '2026-06-16', '2026-06-16'), 'sleep'))
      .toEqual([{ date: '2026-06-16', value: 7 * 60 + 5 }]);
  });

  it('does not let a night reach past the end of the range', async () => {
    // The other edge: the 16th's share exists but was not asked for.
    await seed([{
      typeId: 'sleep',
      startedAt: at('2026-06-15', 23, 10),
      endedAt: at('2026-06-16', 7, 5),
    }]);

    expect(series(await stats('sleep', '2026-06-15', '2026-06-15'), 'sleep'))
      .toEqual([{ date: '2026-06-15', value: 50 }]);
  });

  it('leaves a running timer out of every day, including its own', async () => {
    // Its length changes with the clock, so counting it makes a figure that
    // moves while nobody touches anything (spec 3.4.1 rule 3). This is why
    // the chart has to say it shows finished records only (spec 7.7).
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 14) },
      { typeId: 'sleep', startedAt: at(DAY, 20), active: true },
    ]);

    expect(series(await stats('sleep', DAY, DAY), 'sleep')).toEqual([{ date: DAY, value: 60 }]);
  });

  it('leaves out a record that was never given an end time', async () => {
    // Not a running timer -- a back-filled record waiting to be completed
    // (spec 3.5). It has no length either.
    await seed([{ typeId: 'sleep', startedAt: at(DAY, 13) }]);

    expect(series(await stats('sleep', DAY, DAY), 'sleep')).toEqual([{ date: DAY, value: 0 }]);
  });

  it('leaves out a deleted night, which keeps its times', async () => {
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 14) },
      { typeId: 'sleep', startedAt: at(DAY, 15), endedAt: at(DAY, 17), deletedAt: at(DAY, 18) },
    ]);

    expect(series(await stats('sleep', DAY, DAY), 'sleep')).toEqual([{ date: DAY, value: 60 }]);
  });

  it('counts only the baby that was asked about', async () => {
    const second = await createBaby(token, { nickname: 'Sibling' });
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 14) },
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 20), baby: second },
    ]);

    expect(series(await stats('sleep', DAY, DAY), 'sleep')).toEqual([{ date: DAY, value: 60 }]);
  });

  it('carries a zero for a day with nothing recorded', async () => {
    // A day with no sleep recorded really had none recorded, so the zero is
    // a fact (spec 7.7) -- unlike a day nobody weighed the baby.
    expect(series(await stats('sleep', '2026-06-15', '2026-06-17'), 'sleep')).toEqual([
      { date: '2026-06-15', value: 0 },
      { date: '2026-06-16', value: 0 },
      { date: '2026-06-17', value: 0 },
    ]);
  });

  it('keeps each duration type apart', async () => {
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 14) },
      { typeId: 'walk', startedAt: at(DAY, 16), endedAt: at(DAY, 16, 30) },
    ]);

    const body = await stats('sleep,walk', DAY, DAY);
    expect(series(body, 'sleep')).toEqual([{ date: DAY, value: 60 }]);
    expect(series(body, 'walk')).toEqual([{ date: DAY, value: 30 }]);
  });

  it('adds up alongside the other aggregations in one request', async () => {
    await seed([
      { typeId: 'sleep', startedAt: at(DAY, 13), endedAt: at(DAY, 14) },
      { typeId: 'bottle', startedAt: at(DAY, 8), value: 120 },
    ]);

    const body = await stats('sleep,bottle', DAY, DAY);
    expect(series(body, 'sleep')).toEqual([{ date: DAY, value: 60 }]);
    expect(series(body, 'bottle')).toEqual([{ date: DAY, value: 120 }]);
  });
});

describe('a year of it', () => {
  /**
   * A year of invented records, in its own database by construction.
   *
   * The integration suite's D1 is created for the tests and thrown away; it
   * is not the development database and cannot reach it. Nothing here is
   * real, and nothing here is anybody's.
   */
  const FROM = '2026-01-01';
  const TO = '2026-12-31';

  beforeEach(async () => {
    const rows: { typeId: string; startedAt: number; value?: number; endedAt?: number }[] = [];
    for (let date = FROM; date <= TO; date = addLocalDays(date, 1)) {
      // Six feeds and six nappies a day, which is a quiet day in practice.
      for (let i = 0; i < 6; i += 1) {
        rows.push({ typeId: 'bottle', startedAt: at(date, 2 + i * 3, 10), value: 100 + i });
        rows.push({ typeId: 'diaper', startedAt: at(date, 3 + i * 3, 20), value: 1 });
      }
      // Weighed once a week, which is what makes the gaps matter.
      if (date.endsWith('01') || date.endsWith('08')) {
        rows.push({ typeId: 'weight', startedAt: at(date, 9), value: 7000 + rows.length });
      }
      // A night across midnight every night, which is the case the split
      // exists for, plus a nap that stays inside the day.
      rows.push({
        typeId: 'sleep',
        startedAt: at(date, 23, 10),
        endedAt: at(addLocalDays(date, 1), 7, 5),
      });
      rows.push({ typeId: 'sleep', startedAt: at(date, 13), endedAt: at(date, 14, 30) });
    }
    await seed(rows);
  });

  it('returns one point per day and not one row per event', async () => {
    const body = await stats('bottle', FROM, TO);
    const points = series(body, 'bottle');

    expect(points).toHaveLength(365);
    expect(points[0]).toEqual({ date: FROM, value: 100 + 101 + 102 + 103 + 104 + 105 });
  });

  it('splits a year of nights without growing the number of points', async () => {
    const points = series(await stats('sleep', FROM, TO), 'sleep');

    expect(points).toHaveLength(365);
    // The first day has only its own evening and nap, because the fixture
    // starts here and there is no night before it. Every later day also
    // carries the morning hours of the night before -- which is the split
    // working at scale. Whether the *widened lower bound* works is a
    // separate question, tested on its own above; this fixture has nothing
    // outside the range for it to reach.
    expect(points[0]).toEqual({ date: FROM, value: 50 + 90 });
    expect(points[1]).toEqual({ date: '2026-01-02', value: 7 * 60 + 5 + 50 + 90 });
  });

  it('asks the database no more times for durations than for anything else', async () => {
    const { response, queries } = await requestCounting(
      statsUrl('sleep', FROM, TO),
      {},
      token,
    );

    expect(response.status).toBe(200);
    expect(queries).toBeLessThanOrEqual(MAX_QUERIES_PER_REQUEST);
    // The session, the permission check, and one statement for the split --
    // not one per day and not one per night.
    expect(queries).toBeLessThanOrEqual(4);
  });

  it('leaves the weeks nobody weighed out of the growth series', async () => {
    const points = series(await stats('weight', FROM, TO), 'weight');

    // Two weighings a month, and not 365 points with 341 zeros in them.
    expect(points).toHaveLength(24);
    expect(points.every((p) => p.value > 0)).toBe(true);
  });

  /**
   * The guardrail spec 11.2 asks for.
   *
   * Neither the 50-query limit nor the 10 ms CPU limit is enforced by the
   * local runtime, so a handler that had become N+1 would pass every other
   * test in this file and fail in production against exactly this much data.
   * Counting here is the only way the limit is real.
   *
   * This says nothing about CPU. That can only be measured on a deployed
   * Worker (spec 9.3, 11.2) and is still outstanding.
   */
  it('asks the database a handful of times, not once per day', async () => {
    const { response, queries } = await requestCounting(
      statsUrl('bottle,diaper,weight,sleep', FROM, TO),
      {},
      token,
    );

    expect(response.status).toBe(200);
    expect(queries).toBeLessThanOrEqual(MAX_QUERIES_PER_REQUEST);
    // Named rather than merely bounded, so a change that doubled it would
    // have to be looked at instead of sliding under the threshold: the
    // session, the permission check, and one statement per aggregation
    // family however many types are asked for.
    expect(queries).toBeLessThanOrEqual(7);
  });

  it('costs one statement per aggregation family, not one per type', async () => {
    // The bound that actually holds, pinned here rather than left as a
    // number somebody measured once. Two types that aggregate the same way
    // share a statement; a third family adds one. Nothing here is per type
    // and nothing is per day.
    const one = await requestCounting(statsUrl('bottle', FROM, TO), {}, token);
    const sameFamily = await requestCounting(statsUrl('bottle,diaper', FROM, TO), {}, token);
    const twoFamilies = await requestCounting(statsUrl('bottle,weight', FROM, TO), {}, token);
    const threeFamilies = await requestCounting(statsUrl('bottle,weight,sleep', FROM, TO), {}, token);
    const threeFamiliesMoreTypes = await requestCounting(
      statsUrl('bottle,diaper,weight,height,sleep,walk', FROM, TO), {}, token);

    expect(sameFamily.queries).toBe(one.queries);
    expect(twoFamilies.queries).toBe(one.queries + 1);
    expect(threeFamilies.queries).toBe(one.queries + 2);
    expect(threeFamiliesMoreTypes.queries).toBe(threeFamilies.queries);

    // And there are only three families to have, so the whole request is
    // bounded however many types are asked about.
    expect(threeFamilies.queries).toBeLessThanOrEqual(MAX_QUERIES_PER_REQUEST);
  });

  it('returns at most one point per day per series, not per request', async () => {
    // Spec 5.6's cap is per series. A request for four types over a year is
    // four series of up to 366 points, and the SQL behind it returns up to
    // four rows per day -- which is the thing the cap does not bound.
    const body = await stats('bottle,diaper,weight,sleep', FROM, TO);

    expect(body.series).toHaveLength(4);
    for (const one of body.series) {
      expect(one.points.length, one.typeId).toBeLessThanOrEqual(366);
    }
    expect(body.series.reduce((n, one) => n + one.points.length, 0)).toBeGreaterThan(366);
  });

  it('does not grow its query count with the number of days', async () => {
    const types = 'bottle,diaper,weight,sleep';
    const oneDay = await requestCounting(statsUrl(types, FROM, FROM), {}, token);
    const oneYear = await requestCounting(statsUrl(types, FROM, TO), {}, token);

    expect(oneDay.response.status).toBe(200);
    expect(oneYear.response.status).toBe(200);
    expect(oneYear.queries).toBe(oneDay.queries);
  });
});

describe('the query counter itself', () => {
  it('refuses a request that cost more than the budget', async () => {
    // A guard nobody has seen refuse anything is not a guard. The budget is
    // lowered to one here rather than an N+1 being added to a handler, so
    // the thing under test is the enforcement and not a deliberate bug.
    await expect(requestCounting(statsUrl('diaper', DAY, DAY), {}, token, 1))
      .rejects.toThrow(/over the budget of 1/);
  });

  it('says nothing about a request inside the budget', () => {
    expect(() => enforceBudget('/anything', MAX_QUERIES_PER_REQUEST, MAX_QUERIES_PER_REQUEST))
      .not.toThrow();
    expect(() => enforceBudget('/anything', MAX_QUERIES_PER_REQUEST + 1, MAX_QUERIES_PER_REQUEST))
      .toThrow(/spec 11.2/);
  });


  it('counts what a request actually executed', async () => {
    // A counter that reported zero would make every guardrail above pass
    // for the wrong reason, so it is checked against a request known to
    // touch the database more than once.
    const { queries } = await requestCounting(statsUrl('diaper', DAY, DAY), {}, token);
    expect(queries).toBeGreaterThan(1);
  });

  it('counts each statement of a batch, the way D1 charges for it', async () => {
    // Creating an event writes through `batch()` (spec 4.3), so a counter
    // blind to batches would report writes as free.
    const { response, queries } = await requestCounting(
      `/api/babies/${babyId}/events`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: crypto.randomUUID(),
          typeId: 'diaper',
          intent: 'record',
          startedAt: at(DAY, 9),
          endedAt: null,
        }),
      },
      token,
    );
    // The session, the permission check, the idempotency read-back, the
    // daily-limit count, and the batch itself.
    expect(response.status).toBe(201);
    expect(queries).toBeGreaterThan(2);
  });
});
