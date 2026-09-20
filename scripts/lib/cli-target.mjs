import { DEV_DATABASE, PRODUCTION_DATABASE } from './d1.mjs';

/**
 * Deciding which database a maintenance command is about to change, and
 * whether it has to be confirmed first.
 *
 * Split out from the command itself so the rules can be tested. Getting
 * this wrong is not the kind of mistake that shows up as an error: a
 * command meant for a scratch database that reached the family's records
 * would print exactly the same "Done" (spec 12.1).
 */

/** Commands that only read. Everything else changes something. */
const READ_ONLY = new Set(['list', 'babies']);

export function isWrite(command) {
  return !READ_ONLY.has(command);
}

/**
 * Pulls the flags out of argv, leaving the command's own arguments.
 *
 * `--remote` is a flag and never a default. There is no environment
 * variable for it either: something that reaches real records should take a
 * deliberate keystroke every single time.
 *
 * `--yes` is pulled out too, not to honour it but so it cannot be swallowed
 * as a command argument. The caller refuses it.
 */
export function parseArgs(argv) {
  const rest = [];
  let remote = false;
  let assumeYes = false;
  let weakPassword = false;

  for (const argument of argv) {
    if (argument === '--remote') remote = true;
    else if (argument === '--local') remote = false;
    else if (argument === '--yes' || argument === '-y') assumeYes = true;
    else if (argument === '--weak-password') weakPassword = true;
    else rest.push(argument);
  }

  const [command, ...args] = rest;
  return { command, args, remote, assumeYes, weakPassword };
}

/**
 * Whether a password shorter than the policy may be set.
 *
 * Only on the local database. The minimum exists because the platform caps
 * hashing cost far below what OWASP asks for, which leaves length as the
 * thing actually protecting the database if it ever leaks (spec 9.3) --
 * and the database that could leak is the deployed one. A scratch database
 * of invented records on a home network is not that, and typing
 * twenty-four generated characters into a phone to check whether a button
 * is reachable is its own kind of bad idea.
 *
 * Refused for the deployed database rather than discouraged, because the
 * whole value of the rule is that it has no exceptions where it counts.
 */
export function weakPasswordAllowed({ remote, weakPassword }) {
  return weakPassword === true && remote === false;
}

export function targetFor(remote) {
  return remote
    ? { database: PRODUCTION_DATABASE, remote: true }
    : { database: DEV_DATABASE, remote: false };
}

/**
 * Whether the operator has to type something before this runs.
 *
 * Only for writes against the deployed database. Asking on every local
 * command would teach the habit of confirming without reading, which is
 * exactly the habit that makes the prompt useless when it matters.
 *
 * There is no way to skip it. `--yes` is parsed only so that it cannot be
 * mistaken for a username, and then refused: nothing here runs unattended,
 * and a flag that turned the prompt off would end up in a shell history and
 * be reused by whoever recalled that line next.
 */
export function needsConfirmation({ command, remote }) {
  return remote && isWrite(command);
}

/** The banner printed before anything happens. */
export function banner(target) {
  const lines = ['', `  Database:  ${target.database}`];

  if (target.remote) {
    lines.push('  Location:  REMOTE - the deployed database, holding real records');
  } else {
    lines.push('  Location:  local - a scratch database with invented data only');
  }

  lines.push('');
  return lines.join('\n');
}
