import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Thin wrapper over `wrangler d1 execute`.
 *
 * Which database a command reaches is never implied. Every call names one,
 * and reaching a deployed one takes an explicit `remote: true` that the
 * calling script has to have been asked for on the command line. The
 * failure this guards against is quiet: a command that was meant for a
 * scratch database and went to the family's records instead looks exactly
 * like a command that worked (spec 13.5).
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API_DIR = resolve(REPO_ROOT, 'packages/api');

/** The one configuration file that decides what any of these names mean. */
export const API_CONFIG = resolve(API_DIR, 'wrangler.jsonc');

/** The environment in that file holding the deployed worker and database. */
export const PRODUCTION_ENV = 'production';

/**
 * Commands name the *binding*, not the database.
 *
 * Which database `DB` resolves to is decided in one place, by the
 * configuration file and the environment. Passing a literal name would let
 * a script and the deployed worker disagree about what they are talking to,
 * which is how the backup script came to mean `dongfan` while the worker
 * was bound to `dongfan-dev`.
 */
const BINDING = 'DB';

/** The only database these scripts may create, seed or destroy. */
export const DEV_DATABASE = 'dongfan-dev';

/** The deployed one. Named here so no script has to spell it out. */
export const PRODUCTION_DATABASE = 'dongfan';

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

function run(args) {
  const output = execFileSync('npx', ['wrangler', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const start = output.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(output.slice(start))[0]?.results ?? [];
}

/**
 * Runs one statement against a named database.
 *
 * `remote` is a required part of the target, not an option with a default:
 * wrangler's own default for some of these commands is undocumented, and
 * guessing wrong is how a backup silently reads an empty local file or a
 * drill writes over real data (spec 12.2).
 */
export function executeOn(target, sql) {
  const { database, remote } = target;
  if (!database) throw new Error('No database named');
  if (remote !== true && remote !== false) throw new Error('Target must say local or remote');
  if (remote && database === DEV_DATABASE) {
    throw new Error(`${DEV_DATABASE} is a local scratch database; there is no remote one`);
  }

  return run([
    'd1', 'execute', BINDING,
    '--config', API_CONFIG,
    ...(remote ? ['--env', PRODUCTION_ENV, '--remote'] : ['--local']),
    '--json', '--command', sql,
  ]);
}

/** Applies a file of statements, for the restore drill. */
export function executeFileOn(target, file) {
  if (target.remote) throw new Error('Refusing to apply a file to a deployed database');
  return run(['d1', 'execute', BINDING, '--config', API_CONFIG, '--local', '--json', '--file', file]);
}

/** The local development database, which is where the dev scripts work. */
export const DEV_TARGET = { database: DEV_DATABASE, remote: false };

export function execute(sql) {
  return executeOn(DEV_TARGET, sql);
}

/**
 * A line naming the database a command is about to change.
 *
 * Printed before anything happens, every time, because the one thing that
 * must never be ambiguous is which records are at stake.
 */
export function describeTarget(target) {
  return target.remote
    ? `REMOTE  ${target.database}  (deployed - real records)`
    : `local   ${target.database}`;
}
