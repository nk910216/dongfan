#!/usr/bin/env node
/**
 * Account and membership management.
 *
 * There is no sign-up page by design, so accounts are made here (spec 9.1).
 * Passwords are generated rather than chosen: the platform caps hashing cost
 * well below what OWASP asks for, so length is what actually protects the
 * database, and a generated secret is the only reliable way to get it
 * (spec 9.3).
 *
 * A password is never taken from the command line, where it would be left
 * behind in shell history.
 *
 * The database is chosen by `--remote` and by nothing else: no environment
 * variable, no default, no memory of last time. Every run prints which one
 * it is about to change before it changes it, and a write to the deployed
 * one has to be confirmed by typing its name. Locking the only two accounts
 * out of a household app is quick and quiet, and there is no undo
 * (spec 12.1).
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, hashPassword, isPasswordLengthValid, passwordLength,
} from '../packages/shared/dist/index.js';
import { executeOn, literal } from './lib/d1.mjs';
import { banner, needsConfirmation, parseArgs, targetFor } from './lib/cli-target.mjs';

const GENERATED_PASSWORD_BYTES = 18; // 24 base64url characters, 144 bits.

function generatePassword() {
  return randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url');
}

async function promptPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('Password (blank to generate one): ');
  rl.close();
  return answer.trim();
}

/**
 * Resolves a password, generating one when none was typed.
 *
 * Shared by create and password so the same rule applies to both: a reset
 * that accepted a weak password would undo the strength the account was
 * created with, and that is exactly when nobody is watching.
 */
async function resolvePassword() {
  const chosen = await promptPassword();
  if (chosen === '') return { password: generatePassword(), generated: true };

  if (!isPasswordLengthValid(chosen)) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} ` +
        `characters; that one is ${passwordLength(chosen)}. ` +
        'Leave the prompt blank to generate one.',
    );
  }
  return { password: chosen, generated: false };
}

/**
 * The database this run works on.
 *
 * Module scope rather than threaded through every command: a parameter that
 * one command forgot to pass would silently fall back to a default, and the
 * whole point is that there is no default.
 */
let target = null;

function execute(sql) {
  if (target === null) throw new Error('No database chosen');
  return executeOn(target, sql);
}

function findUser(username) {
  const rows = execute(
    `SELECT id, username, disabled_at FROM users WHERE lower(username) = lower(${literal(username)})`,
  );
  return rows[0] ?? null;
}

/**
 * Makes the operator type the database name before a deployed change.
 *
 * Typing the name rather than pressing y: a prompt answered from muscle
 * memory is not a confirmation, and this one exists for the run where the
 * flag was left on the line from last time.
 */
async function confirm(description) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(
    `About to run "${description}" against ${target.database}, which holds real records.\n` +
      `Type the database name to continue: `,
  );
  rl.close();

  if (answer.trim() !== target.database) throw new Error('Cancelled.');
}

const commands = {
  async create(username) {
    if (findUser(username)) throw new Error(`User already exists: ${username}`);

    const { password, generated } = await resolvePassword();
    const id = randomUUID();
    execute(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES (${literal(id)}, ${literal(username)}, ${literal(await hashPassword(password))}, ${Date.now()})`,
    );

    console.log(`Created ${username}`);
    if (generated) console.log(`Password: ${password}`);
  },

  async password(username) {
    const user = findUser(username);
    if (!user) throw new Error(`No such user: ${username}`);

    const { password, generated } = await resolvePassword();

    execute(
      `UPDATE users SET password_hash = ${literal(await hashPassword(password))} WHERE id = ${literal(user.id)}`,
    );

    // Changing a password does not invalidate existing sessions: they are
    // independent credentials with their own lifetime. After a leak both
    // steps are needed (spec 9.1).
    console.log(`Password updated for ${username}`);
    if (generated) console.log(`Password: ${password}`);
    console.log('Existing sessions remain valid. Run `revoke` as well if this was a leak.');
  },

  async revoke(username) {
    const user = findUser(username);
    if (!user) throw new Error(`No such user: ${username}`);
    execute(`DELETE FROM sessions WHERE user_id = ${literal(user.id)}`);
    console.log(`Revoked all sessions for ${username}`);
  },

  async disable(username) {
    const user = findUser(username);
    if (!user) throw new Error(`No such user: ${username}`);
    execute(`UPDATE users SET disabled_at = ${Date.now()} WHERE id = ${literal(user.id)}`);
    execute(`DELETE FROM sessions WHERE user_id = ${literal(user.id)}`);
    console.log(`Disabled ${username} and revoked their sessions`);
  },

  async enable(username) {
    const user = findUser(username);
    if (!user) throw new Error(`No such user: ${username}`);
    execute(`UPDATE users SET disabled_at = NULL WHERE id = ${literal(user.id)}`);
    console.log(`Enabled ${username}`);
  },

  async assign(username, babyId, role = 'member') {
    if (role !== 'owner' && role !== 'member') throw new Error(`Unknown role: ${role}`);

    const user = findUser(username);
    if (!user) throw new Error(`No such user: ${username}`);
    if (execute(`SELECT id FROM babies WHERE id = ${literal(babyId)}`).length === 0) {
      throw new Error(`No such baby: ${babyId}`);
    }

    // This is what lets two people share a baby in the first milestone,
    // before the invite code screen exists (spec 12).
    execute(
      `INSERT INTO baby_members (baby_id, user_id, role, created_at)
       VALUES (${literal(babyId)}, ${literal(user.id)}, ${literal(role)}, ${Date.now()})
       ON CONFLICT (user_id, baby_id) DO UPDATE SET role = ${literal(role)}`,
    );
    console.log(`${username} is now ${role} of ${babyId}`);
  },

  async list() {
    const rows = execute('SELECT username, disabled_at, created_at FROM users ORDER BY username');
    if (rows.length === 0) return console.log('No users yet.');
    for (const row of rows) {
      console.log(`${row.username}${row.disabled_at ? '  (disabled)' : ''}`);
    }
  },

  async babies() {
    const rows = execute(
      `SELECT b.id, b.nickname, b.timezone, COUNT(m.user_id) AS members
         FROM babies b LEFT JOIN baby_members m ON m.baby_id = b.id
        GROUP BY b.id ORDER BY b.created_at`,
    );
    if (rows.length === 0) return console.log('No babies yet.');
    for (const row of rows) {
      console.log(`${row.id}  ${row.nickname}  (${row.timezone}, ${row.members} member(s))`);
    }
  },
};

const { command, args, remote, assumeYes } = parseArgs(process.argv.slice(2));

if (!command || !(command in commands)) {
  console.error(`Usage: node scripts/users.mjs <command> [args]

  create   <username>              Create an account, generating a password
  password <username>              Set a new password
  revoke   <username>              Revoke every session
  disable  <username>              Disable the account and revoke sessions
  enable   <username>              Re-enable a disabled account
  assign   <username> <babyId> [role]   Add as member (default) or owner
  list                             List accounts
  babies                           List babies and their member counts

Flags:
  --remote    Work on the deployed database instead of the local one.
              Writes ask you to type the database name first.
  --local     The default, stated explicitly.

Without --remote everything here works on dongfan-dev, a scratch database
holding invented records only.`);
  process.exit(1);
}

if (assumeYes) {
  // Refused rather than ignored. A flag that looks like it turns the
  // prompt off, and does not, is worse than no flag: somebody will believe
  // it worked.
  console.error('Error: there is no --yes here. A deployed change is confirmed by hand.');
  process.exit(1);
}

target = targetFor(remote);
process.stderr.write(banner(target));

try {
  if (needsConfirmation({ command, remote })) {
    await confirm([command, ...args].join(' '));
  }
  await commands[command](...args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
