#!/usr/bin/env node
/**
 * Records how many rows the source database held, beside the backup.
 *
 * Without this the restore drill can only compare a backup against itself:
 * it proves the file restored completely, and says nothing about whether
 * the export was complete in the first place. An export that ran against an
 * empty database, or stopped early, produces a file that restores perfectly
 * (spec 12.2).
 *
 * Taken before the export, so the numbers are a floor. A row written while
 * the export was running shows up as the restore having *more* than this,
 * which is not a loss; fewer is.
 *
 * Usage: node scripts/source-counts.mjs --local|--remote <output.json>
 */

import { writeFileSync } from 'node:fs';
import { DEV_DATABASE, PRODUCTION_DATABASE, executeOn } from './lib/d1.mjs';

/** The tables whose loss would matter. Sessions are not among them. */
export const COUNTED_TABLES = ['babies', 'users', 'baby_members', 'events', 'tags', 'event_tags'];

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const output = args.find((argument) => !argument.startsWith('--'));

if (!output) {
  console.error('Usage: node scripts/source-counts.mjs --local|--remote <output.json>');
  process.exit(64);
}

const target = remote
  ? { database: PRODUCTION_DATABASE, remote: true }
  : { database: DEV_DATABASE, remote: false };

const counts = {};
for (const table of COUNTED_TABLES) {
  counts[table] = Number(executeOn(target, `SELECT COUNT(*) AS n FROM "${table}"`)[0]?.n ?? 0);
}

writeFileSync(
  output,
  `${JSON.stringify({ database: target.database, remote: target.remote, takenAt: new Date().toISOString(), counts }, null, 2)}\n`,
);

console.log(`Source counts: ${COUNTED_TABLES.map((t) => `${t}=${counts[t]}`).join(' ')}`);
