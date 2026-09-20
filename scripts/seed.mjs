#!/usr/bin/env node
/**
 * Fills the local development database with invented records.
 *
 * Everything here is synthetic. The family's real data never reaches a
 * development database, and this script is the reason it does not have to:
 * there is always something realistic to develop against (spec 13.5).
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { hashPassword, toLocalDate } from '../packages/shared/dist/index.js';
import { execute, literal } from './lib/d1.mjs';

const TIMEZONE = 'Asia/Taipei';
const MINUTE = 60_000;

/** Invented names, chosen to look nothing like a real household. */
const SEED_USERS = [
  { username: 'dev-parent-a', role: 'owner' },
  { username: 'dev-parent-b', role: 'member' },
];

const SEED_BABY = {
  nickname: 'Seed Baby',
  gender: 'other',
  birthDate: '2026-03-08',
};

function row(sql) {
  return execute(sql)[0] ?? null;
}

async function main() {
  const existing = row(`SELECT id FROM babies WHERE nickname = ${literal(SEED_BABY.nickname)}`);
  if (existing) {
    console.log('Seed data already present. Delete .wrangler state to start over.');
    return;
  }

  const now = Date.now();
  const babyId = randomUUID();

  execute(
    `INSERT INTO babies (id, nickname, gender, birth_date, timezone, created_at)
     VALUES (${literal(babyId)}, ${literal(SEED_BABY.nickname)}, ${literal(SEED_BABY.gender)},
             ${literal(SEED_BABY.birthDate)}, ${literal(TIMEZONE)}, ${now})`,
  );

  for (const user of SEED_USERS) {
    const password = randomBytes(18).toString('base64url');
    const userId = randomUUID();
    execute(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES (${literal(userId)}, ${literal(user.username)}, ${literal(await hashPassword(password))}, ${now})`,
    );
    execute(
      `INSERT INTO baby_members (baby_id, user_id, role, created_at)
       VALUES (${literal(babyId)}, ${literal(userId)}, ${literal(user.role)}, ${now})`,
    );
    console.log(`${user.username} / ${password}`);
  }

  // A day's worth of activity, including one sleep that crosses midnight so
  // the date handling has something real to be wrong about.
  const events = [
    { typeId: 'sleep', minutesAgo: 9 * 60, durationMinutes: 7 * 60 + 55, value: 1 },
    { typeId: 'bottle', minutesAgo: 8 * 60, value: 120 },
    { typeId: 'diaper', minutesAgo: 7 * 60, value: 1, metadata: { diaper_kind: 'pee' } },
    { typeId: 'nursing', minutesAgo: 5 * 60, durationMinutes: 19, value: 1, metadata: { side: 'both' } },
    { typeId: 'diaper', minutesAgo: 4 * 60, value: 1, metadata: { diaper_kind: 'poo' } },
    { typeId: 'bottle', minutesAgo: 3 * 60, value: 140 },
    { typeId: 'weight', minutesAgo: 2 * 60, value: 7420 },
    { typeId: 'diaper', minutesAgo: 90, value: 1 },
  ];

  let rev = 0;
  for (const event of events) {
    const startedAt = now - event.minutesAgo * MINUTE;
    const endedAt = event.durationMinutes ? startedAt + event.durationMinutes * MINUTE : null;
    rev += 1;

    execute(
      `INSERT INTO events
         (id, baby_id, type_id, created_by, created_at, updated_at, started_at, ended_at,
          local_date, value, note, metadata, version, rev, active, deleted_at)
       VALUES (${literal(randomUUID())}, ${literal(babyId)}, ${literal(event.typeId)},
               (SELECT id FROM users WHERE username = ${literal(SEED_USERS[0].username)}),
               ${now}, ${now}, ${startedAt}, ${endedAt === null ? 'NULL' : endedAt},
               ${literal(toLocalDate(startedAt, TIMEZONE))}, ${event.value},
               '', ${literal(JSON.stringify(event.metadata ?? {}))}, 1, ${rev}, NULL, NULL)`,
    );
  }

  console.log(`\nSeeded baby ${babyId} with ${events.length} events.`);
  console.log(`Assign yourself with: node scripts/users.mjs assign <username> ${babyId} owner`);
}

await main();
