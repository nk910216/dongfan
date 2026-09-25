#!/usr/bin/env node
/**
 * A year of invented records, in a database of its own.
 *
 * `GET /stats` is the one endpoint whose cost depends on how much history a
 * baby has, and spec 5.6 says so in as many words: a year is around 7,300
 * events, and aggregating those in JavaScript would very likely exceed the
 * 10 ms CPU budget -- a failure that only appears once the data exists,
 * which is long after the code was written.
 *
 * So there has to be a year of data to point it at. This builds one.
 *
 * **It is not dongfan-dev.** The owner develops against a handful of records
 * they put there by hand, and burying those under 7,300 invented ones would
 * make the app useless to look at. This database is `dongfan-stats`, in its
 * own configuration file, and this script never reads, empties or writes
 * anything else. Local only: there is no remote database by this name and
 * nothing here passes --remote.
 *
 * What it can and cannot tell you:
 *
 * - **It can** say how long the aggregation takes in the database and how
 *   many rows come back. Those are the architectural claims -- grouping in
 *   SQL, at most one row per day (spec 5.6) -- and they are checkable here.
 * - **It cannot** say anything about the 10 ms CPU limit. Miniflare does not
 *   enforce it (spec 11.2), so a comfortable number here means nothing about
 *   production. That measurement needs a deployed Worker and is listed as
 *   outstanding in AGENTS.md. Do not report it as passed.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { addLocalDays, startOfLocalDay, toLocalDate } from '../packages/shared/dist/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = resolve(REPO_ROOT, 'scripts/wrangler.stats.jsonc');

/** The only database this script may touch. */
const DATABASE = 'dongfan-stats';

const TIMEZONE = 'Asia/Taipei';
const HOUR = 3_600_000;

/** A year ending yesterday, so every day in it is complete. */
const DAYS = 365;

function run(sqlOrFile, { file = false } = {}) {
  const output = execFileSync('npx', [
    'wrangler', 'd1', 'execute', DATABASE,
    // Never --remote. There is no deployed database by this name, and if
    // somebody ever made one this script must still not reach it.
    '--local',
    '--config', CONFIG,
    '--json',
    file ? '--file' : '--command', sqlOrFile,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });

  const start = output.indexOf('[');
  if (start === -1) return { results: [], duration: 0 };
  const parsed = JSON.parse(output.slice(start))[0] ?? {};
  return { results: parsed.results ?? [], duration: parsed.meta?.duration ?? 0 };
}

function migrate() {
  execFileSync('npx', [
    'wrangler', 'd1', 'migrations', 'apply', DATABASE,
    '--local', '--config', CONFIG,
  ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
}

function literal(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Invented records, and deliberately not a plausible household.
 *
 * Six bottles and six nappies a day, a weighing every Monday, and a
 * temperature now and then. The shape matters more than the numbers: `sum`,
 * `count`, `last` and `max` all have to be exercised, and `last` only means
 * anything when most days have no value at all.
 */
function* events() {
  const today = toLocalDate(Date.now(), TIMEZONE);
  let rev = 0;

  for (let i = DAYS; i >= 1; i -= 1) {
    const date = addLocalDays(today, -i);
    const midnight = startOfLocalDay(date, TIMEZONE);

    for (let feed = 0; feed < 6; feed += 1) {
      rev += 1;
      yield { rev, date, typeId: 'bottle', at: midnight + (2 + feed * 3) * HOUR, value: 90 + feed * 5 };
      rev += 1;
      yield { rev, date, typeId: 'diaper', at: midnight + (3 + feed * 3) * HOUR, value: 1 };
    }

    if (new Date(midnight).getUTCDay() === 1) {
      rev += 1;
      yield { rev, date, typeId: 'weight', at: midnight + 9 * HOUR, value: 5000 + (DAYS - i) * 6 };
    }
    if (i % 17 === 0) {
      rev += 1;
      yield { rev, date, typeId: 'temperature', at: midnight + 20 * HOUR, value: 365 + (i % 4) };
    }
  }
}

/**
 * Whether what is in the table is a whole year, and what to do if not.
 *
 * Counting rows and stopping at "more than none" is not enough. The insert
 * goes in chunks, so a run that died partway leaves a few hundred events
 * behind; the next run saw a non-zero count, skipped, and then reported
 * timings for a fortnight of data as though they were a year's. A fixture
 * that quietly measures the wrong thing is worse than no fixture.
 *
 * The window also moves: it ends yesterday, so a fixture built last week
 * covers days that are no longer the year being asked about.
 *
 * Pure, so it can be tested without a database.
 */
export function fixturePlan({ existing, expected, firstDate, lastDate, wantFirst, wantLast }) {
  if (existing === 0) return { action: 'fill', why: 'empty' };
  if (existing !== expected) {
    return { action: 'rebuild', why: `holds ${existing} events, a whole year is ${expected}` };
  }
  if (firstDate !== wantFirst || lastDate !== wantLast) {
    return { action: 'rebuild', why: `covers ${firstDate}..${lastDate}, the year wanted is ${wantFirst}..${wantLast}` };
  }
  return { action: 'keep', why: `already holds a whole year, ${existing} events` };
}

function insert(userId, babyId) {
  const rows = [...events()];
  const statements = rows.map((row) =>
    'INSERT INTO events (id, baby_id, type_id, created_by, created_at, updated_at, started_at,'
    + ' ended_at, local_date, value, note, metadata, version, rev, active, deleted_at) VALUES ('
    + [
      literal(randomUUID()), literal(babyId), literal(row.typeId), literal(userId),
      row.at, row.at, row.at, 'NULL', literal(row.date), row.value,
      literal(''), literal('{}'), 1, row.rev, 'NULL', 'NULL',
    ].join(', ')
    + ');');

  // In chunks, because one statement per row in a single --command would
  // build a megabytes-long argument list.
  const CHUNK = 500;
  for (let i = 0; i < statements.length; i += CHUNK) {
    run(statements.slice(i, i + CHUNK).join('\n'));
  }
  return rows.length;
}

function main() {
  console.log(`  Database:  ${DATABASE}`);
  console.log('  Location:  local - a scratch database for the statistics fixture');
  console.log('             never dongfan-dev, and never anything deployed\n');

  migrate();

  // Looked up rather than assumed. A run that failed partway through has
  // already written the account, and re-inserting it fails on the unique
  // index -- which is how the first version of this script ended up
  // unrunnable a second time.
  const FIXTURE_BABY = 'Fixture Baby';
  const FIXTURE_USER = 'fixture-parent';
  const today = toLocalDate(Date.now(), TIMEZONE);

  let userId = run(`SELECT id FROM users WHERE username = ${literal(FIXTURE_USER)}`).results[0]?.id;
  if (!userId) {
    userId = randomUUID();
    run(`INSERT INTO users (id, username, password_hash, created_at, disabled_at) VALUES (${literal(userId)}, ${literal(FIXTURE_USER)}, ${literal('not-a-real-hash')}, ${Date.now()}, NULL)`);
  }

  let babyId = run(`SELECT id FROM babies WHERE nickname = ${literal(FIXTURE_BABY)}`).results[0]?.id;
  if (!babyId) {
    babyId = randomUUID();
    run(`INSERT INTO babies (id, nickname, gender, birth_date, timezone, created_at) VALUES (${literal(babyId)}, ${literal(FIXTURE_BABY)}, ${literal('other')}, ${literal(addLocalDays(today, -DAYS))}, ${literal(TIMEZONE)}, ${Date.now()})`);
    run(`INSERT INTO baby_members (baby_id, user_id, role, created_at) VALUES (${literal(babyId)}, ${literal(userId)}, ${literal('owner')}, ${Date.now()})`);
  }

  const held = run(
    'SELECT COUNT(*) AS n, MIN(local_date) AS first, MAX(local_date) AS last'
    + ` FROM events WHERE baby_id = ${literal(babyId)}`).results[0] ?? {};

  const plan = fixturePlan({
    existing: held.n ?? 0,
    expected: [...events()].length,
    firstDate: held.first ?? null,
    lastDate: held.last ?? null,
    wantFirst: addLocalDays(today, -DAYS),
    wantLast: addLocalDays(today, -1),
  });

  console.log(`${plan.action}: ${plan.why}`);

  if (plan.action === 'rebuild') {
    // Only this fixture's own rows, in this fixture's own database. Nothing
    // else has ever been written here.
    run(`DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE baby_id = ${literal(babyId)})`);
    run(`DELETE FROM events WHERE baby_id = ${literal(babyId)}`);
  }
  if (plan.action !== 'keep') {
    console.log(`Wrote ${insert(userId, babyId)} invented events across ${DAYS} days.`);
  }

  const from = addLocalDays(today, -DAYS);

  console.log('\nAggregating a year, in SQL:');
  for (const [label, typeId] of [['count (diaper)', 'diaper'], ['sum (bottle)', 'bottle'], ['max (temperature)', 'temperature']]) {
    const { results, duration } = run(
      `SELECT local_date, COUNT(*) AS n, SUM(value) AS total, MAX(value) AS high FROM events`
      + ` WHERE baby_id = ${literal(babyId)} AND deleted_at IS NULL AND type_id = ${literal(typeId)}`
      + ` AND local_date >= ${literal(from)} AND local_date <= ${literal(today)}`
      + ' GROUP BY local_date ORDER BY local_date');
    console.log(`  ${label.padEnd(20)} ${String(results.length).padStart(4)} rows  ${duration} ms`);
  }

  const total = run('SELECT COUNT(*) AS n FROM events').results[0]?.n ?? 0;
  console.log(`\n  ${total} events in the table, at most 366 rows out of each query.`);
  console.log('\n  This says nothing about the 10 ms CPU limit. Miniflare does not');
  console.log('  enforce it, so that measurement still needs a deployed Worker and');
  console.log('  is outstanding (spec 9.3, 11.2, 12.1).');
}

// Only when run, never when imported. `fixturePlan` is unit-tested, and a
// test that imported this file used to shell out to wrangler and fill a
// database as a side effect of reading a pure function.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
