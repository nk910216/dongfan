import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Thin wrapper over `wrangler d1 execute` for the local development database.
 *
 * Local only, and deliberately so: nothing here passes `--remote`, so there
 * is no path from these scripts to the production database (spec 13.5).
 */

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../packages/api');

export const DEV_DATABASE = 'dongfan-dev';

/**
 * Escapes a value for inline SQL.
 *
 * `wrangler d1 execute` takes no bind parameters, so values are inlined.
 * Doubling quotes is the whole of SQLite's escaping rule; a null byte cannot
 * be represented and is rejected rather than quietly truncating the string.
 */
export function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Refusing to inline ${value}`);
    return String(value);
  }
  const text = String(value);
  if (text.includes('\0')) throw new Error('Value contains a null byte');
  return `'${text.replaceAll("'", "''")}'`;
}

export function execute(sql) {
  const output = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', DEV_DATABASE, '--local', '--json', '--command', sql],
    { cwd: API_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const start = output.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(output.slice(start))[0]?.results ?? [];
}
