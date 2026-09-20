#!/usr/bin/env node
/**
 * Restores a backup into a scratch database and checks it came back whole.
 *
 * A backup file with `INSERT INTO events` in it proves there is a file. It
 * does not prove the records can be recovered, and the day that matters is
 * the worst possible day to find out (spec 12.2). So this actually restores
 * one, counts what arrived, and reads a few rows back.
 *
 * The scratch database is local and its own: `scripts/wrangler.drill.jsonc`
 * names nothing else, and this script never passes --remote. A drill that
 * could write over the thing it is rehearsing to protect would be worse
 * than no drill (spec 13.5).
 *
 * Usage:
 *   node scripts/restore-drill.mjs <backup.sql>
 *   node scripts/restore-drill.mjs <backup.sql> --compare-local
 *
 * `--compare-local` also checks the counts against the local development
 * database, which is what makes a drill on a freshly exported local backup
 * prove something by itself rather than needing someone to read the numbers.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { toLocalDate } from '../packages/shared/dist/index.js';
import { DEV_TARGET, executeOn } from './lib/d1.mjs';
import { countRowsFor, partitionRestore, splitStatements } from './lib/sql-file.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRILL_CONFIG = resolve(REPO_ROOT, 'scripts/wrangler.drill.jsonc');
const DRILL_DATABASE = 'dongfan-drill';

/** The tables whose contents have to survive, and the order they read in. */
const TABLES = ['babies', 'users', 'baby_members', 'events', 'tags', 'event_tags'];

function drill(sqlOrFile, { file = false } = {}) {
  const args = [
    'wrangler', 'd1', 'execute', DRILL_DATABASE,
    // Never --remote. There is no deployed database by this name, and if
    // somebody ever made one this script must still not reach it.
    '--local',
    '--config', DRILL_CONFIG,
    '--json',
    file ? '--file' : '--command', sqlOrFile,
  ];

  const output = execFileSync('npx', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const start = output.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(output.slice(start))[0]?.results ?? [];
}

function countIn(runner, table) {
  return Number(runner(`SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n ?? 0);
}

/**
 * Empties the scratch database before restoring into it.
 *
 * Without this a second drill would restore on top of the first and every
 * count would be doubled, or the primary keys would collide and the run
 * would fail for a reason that has nothing to do with the backup.
 */
function emptyTheScratchDatabase() {
  // `_cf_METADATA` belongs to D1 itself and dropping it is refused, which
  // would fail the reset before it had dropped anything.
  const tables = drill(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
  ).map((row) => row.name);

  if (tables.length === 0) return;

  const statements = [
    'PRAGMA defer_foreign_keys=TRUE;',
    ...tables.map((name) => `DROP TABLE IF EXISTS "${name}";`),
  ].join('\n');

  const path = resolve(tmpdir(), `dongfan-drill-reset-${process.pid}.sql`);
  writeFileSync(path, statements);
  drill(path, { file: true });
}

/** Applies one pass, as a single file so wrangler sends it in one go. */
function applyPass(label, statements, prelude = '') {
  if (statements.length === 0) return;

  const path = resolve(tmpdir(), `dongfan-drill-${label}-${process.pid}.sql`);
  writeFileSync(path, `${prelude}${statements.join(';\n')};\n`);
  drill(path, { file: true });
  console.log(`  ${label.padEnd(8)} ${statements.length} statements applied`);
}

/**
 * Foreign keys are checked at the end of the rows pass, not row by row.
 *
 * The dump is ordered alphabetically, so a `baby_members` row arrives
 * before the `users` row it points at. Deferring works here and did not
 * work in the export as written, because there it had to survive a
 * statement that failed to prepare at all.
 */
const DEFER_KEYS = 'PRAGMA defer_foreign_keys=TRUE;\n';

function fail(message) {
  console.error(`\nDrill failed: ${message}`);
  process.exit(1);
}

/**
 * Why wrangler refused.
 *
 * It reports a SQL error as JSON on stdout and leaves stderr empty, so
 * showing only stderr gives a failed drill with no reason attached.
 */
function describe(error) {
  const parts = [error.message];
  for (const stream of [error.stdout, error.stderr]) {
    if (typeof stream === 'string' && stream.trim() !== '') parts.push(stream.trim());
  }
  return parts.join('\n\n');
}

function main() {
  const args = process.argv.slice(2);
  const compareLocal = args.includes('--compare-local');
  const backup = args.find((arg) => !arg.startsWith('--'));

  if (!backup) {
    console.error('Usage: node scripts/restore-drill.mjs <backup.sql> [--compare-local]');
    process.exit(64);
  }

  const path = resolve(process.cwd(), backup);
  const contents = readFileSync(path, 'utf8');
  console.log(`Backup   ${path}`);
  console.log(`         ${contents.length} bytes\n`);

  const statements = splitStatements(contents);
  const { schema, data } = partitionRestore(statements);
  console.log(`         ${schema.length} schema statements, ${data.length} rows\n`);

  console.log(`Restoring into the local scratch database ${DRILL_DATABASE}`);
  emptyTheScratchDatabase();

  // Two passes, tables first. Applied as exported, the restore stops with
  // "no such table: main.users": the dump is ordered alphabetically, so
  // baby_members and its foreign key arrive before users, and the
  // PRAGMA defer_foreign_keys at the top does not survive being run
  // statement by statement. Anyone restoring for real will meet this, so
  // the drill does it the way that works.
  applyPass('schema', schema);
  applyPass('rows', data, DEFER_KEYS);

  // ---------------------------------------------------------------- counts

  console.log('\nRows restored');
  const restored = {};
  for (const table of TABLES) {
    restored[table] = countIn(drill, table);
    console.log(`  ${table.padEnd(14)} ${String(restored[table]).padStart(6)}`);
  }

  if (restored['events'] === 0) fail('no events came back');

  // Against the file itself, which is the comparison that works whatever
  // the backup came from: a restore that stopped partway leaves tables
  // filled and tables empty, and the counts alone would look plausible.
  console.log('\nAgainst the rows the file carries');
  const missing = [];
  for (const table of TABLES) {
    const inFile = countRowsFor(statements, table);
    const same = inFile === restored[table];
    console.log(`  ${table.padEnd(14)} ${String(inFile).padStart(6)}  ${same ? 'same' : 'DIFFERENT'}`);
    if (!same) missing.push(`${table}: ${inFile} in the file, ${restored[table]} restored`);
  }
  if (missing.length > 0) fail(`the restore did not bring everything back\n  ${missing.join('\n  ')}`);

  if (compareLocal) {
    console.log('\nAgainst the local development database');
    const mismatches = [];
    for (const table of TABLES) {
      const source = countIn((sql) => executeOn(DEV_TARGET, sql), table);
      const same = source === restored[table];
      console.log(`  ${table.padEnd(14)} ${String(source).padStart(6)}  ${same ? 'same' : 'DIFFERENT'}`);
      if (!same) mismatches.push(`${table}: ${source} before, ${restored[table]} after`);
    }
    if (mismatches.length > 0) fail(`counts do not match\n  ${mismatches.join('\n  ')}`);
  }

  // ------------------------------------------------------------ spot checks

  console.log('\nSpot checks');

  // Dates are checked in the baby's timezone, never in UTC. SQLite has no
  // IANA timezones, and `date(started_at/1000,'unixepoch')` would answer
  // for a baby in London: for Taipei it moves midnight by eight hours and
  // picks out the wrong events entirely (spec 3.4).
  const timed = drill(
    `SELECT e.id, e.type_id, e.started_at, e.ended_at, e.local_date, b.timezone
       FROM events e
       JOIN babies b ON b.id = e.baby_id
      WHERE e.deleted_at IS NULL`,
  );

  // Every stored local_date has to still agree with its timestamp. This is
  // the one field a restore could bring back subtly wrong -- shifted by a
  // day, or by a timezone -- while every count matched.
  const disagreeing = timed.filter(
    (row) => row.local_date !== toLocalDate(row.started_at, row.timezone),
  );
  if (disagreeing.length > 0) {
    const first = disagreeing[0];
    fail(
      `${disagreeing.length} events have a local_date that no longer matches their time\n` +
        `  ${first.id}: stored ${first.local_date}, ` +
        `computed ${toLocalDate(first.started_at, first.timezone)} in ${first.timezone}`,
    );
  }
  console.log(`  local dates        ${timed.length} agree with their timestamps`);

  // A sleep that began one evening and ended the next morning. This is the
  // shape every date bug in this project has taken, so the drill looks at
  // one specifically rather than at whatever row happens to be first.
  const overnight = timed.find(
    (row) =>
      row.ended_at !== null &&
      toLocalDate(row.ended_at, row.timezone) !== toLocalDate(row.started_at, row.timezone),
  );

  if (!overnight) fail('no event crossing midnight came back, so the hardest case is untested');
  const span = (overnight.ended_at - overnight.started_at) / 3_600_000;
  console.log(
    `  crossing midnight  ${overnight.type_id} ${overnight.local_date} ` +
      `-> ${toLocalDate(overnight.ended_at, overnight.timezone)}, ${span.toFixed(1)}h`,
  );
  if (!(span > 0 && span <= 24)) fail(`that event spans ${span} hours, which cannot be right`);

  // An event with a tag, because the association lives in its own table
  // and a restore that brought back every event and lost the join would
  // look entirely healthy from the counts alone.
  const tagged = drill(
    `SELECT e.id, e.type_id, e.local_date, group_concat(t.name) AS tags
       FROM events e
       JOIN event_tags et ON et.event_id = e.id
       JOIN tags t ON t.id = et.tag_id
      GROUP BY e.id ORDER BY e.started_at LIMIT 1`,
  )[0];

  if (!tagged) fail('no tagged event came back, so the associations are unproven');
  console.log(`  with tags          ${tagged.type_id} on ${tagged.local_date}, tagged ${tagged.tags}`);

  // The constraints matter as much as the rows: a restore that dropped the
  // unique index on (baby_id, rev) would accept two rows sharing a rev
  // later, and pagination would start losing data silently (spec 5.4).
  const indexes = drill(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`,
  ).map((row) => row.name);

  for (const required of ['idx_events_baby_rev', 'idx_events_active']) {
    if (!indexes.includes(required)) fail(`the index ${required} did not come back`);
    console.log(`  index              ${required}`);
  }

  const shared = drill(
    `SELECT baby_id, rev, COUNT(*) AS n FROM events GROUP BY baby_id, rev HAVING n > 1`,
  );
  if (shared.length > 0) fail('two events share a rev, which pagination would silently skip past');
  console.log('  revs               all distinct per baby');

  const orphans = drill(
    `SELECT COUNT(*) AS n FROM event_tags et
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = et.event_id)
         OR NOT EXISTS (SELECT 1 FROM tags WHERE id = et.tag_id)`,
  )[0];
  if (Number(orphans?.n ?? 0) > 0) fail(`${orphans.n} tag associations point at rows that are not there`);
  console.log('  tag associations   all resolve');

  console.log('\nDrill passed.');
  console.log(`\n${CURSOR_WARNING}`);
}

/**
 * The part of a restore that is not about the database at all.
 *
 * Restoring an older backup moves `rev` backwards, and a phone still holds
 * the larger cursor it had before. `rev > since` then matches nothing, for
 * ever: the app looks perfectly healthy and silently never syncs again
 * (spec 12.2).
 */
const CURSOR_WARNING = `After restoring to a real database, every client cursor must be reset:

  1. Keep whatever is waiting to be sent. It is not on the server yet.
  2. Clear the synced local cache and the sync cursor.
  3. Sync again from since=0.
  4. Send the kept items.

Restoring an older backup moves rev backwards. A phone holding a larger
cursor asks for rev > since, matches nothing, and goes on looking healthy
while never receiving another record.

In this milestone the web client keeps no sync cursor yet -- only the
unresolved adds in dongfan.pending-creates, which are step 1. Steps 2 and 3
become real with the offline layer in M2.`;

try {
  main();
} catch (error) {
  fail(describe(error));
}
