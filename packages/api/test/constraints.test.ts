import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createBaby, signedInUser } from './helpers.js';

/**
 * The database-level guarantees.
 *
 * These are enforced in SQL rather than in a handler because every one of
 * them protects against two requests racing, which no application check can
 * win. Asserting them here means a future migration cannot quietly drop one.
 */

const PASSWORD = 'a-long-random-password-1234';

async function setup(): Promise<{ babyId: string; userId: string }> {
  const { id: userId, token } = await signedInUser('parent', PASSWORD);
  return { babyId: await createBaby(token), userId };
}

type EventOverrides = {
  id?: string;
  typeId?: string;
  rev?: number;
  active?: number | null;
  endedAt?: number | null;
  deletedAt?: number | null;
};

async function insertEvent(
  babyId: string,
  userId: string,
  overrides: EventOverrides = {},
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO events
       (id, baby_id, type_id, created_by, created_at, updated_at, started_at, ended_at,
        local_date, value, note, metadata, version, rev, active, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20', 1, '', '{}', 1, ?, ?, ?)`,
  )
    .bind(
      overrides.id ?? crypto.randomUUID(),
      babyId,
      overrides.typeId ?? 'sleep',
      userId,
      now,
      now,
      now,
      overrides.endedAt ?? null,
      overrides.rev ?? 1,
      overrides.active ?? null,
      overrides.deletedAt ?? null,
    )
    .run();
}

describe('rev is unique per baby', () => {
  it('refuses a second event with the same rev', async () => {
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { rev: 1 });

    // A batch update that computed one rev for several rows would land here.
    // Without this index it would succeed and pagination would skip rows.
    await expect(insertEvent(babyId, userId, { rev: 1 })).rejects.toThrow();
  });

  it('allows the same rev under a different baby', async () => {
    const { babyId, userId } = await setup();
    const { token } = await signedInUser('second', PASSWORD);
    const otherBaby = await createBaby(token);

    await insertEvent(babyId, userId, { rev: 1 });
    await expect(insertEvent(otherBaby, userId, { rev: 1 })).resolves.toBeUndefined();
  });

  it('allows increasing revs for the same baby', async () => {
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { rev: 1 });
    await expect(insertEvent(babyId, userId, { rev: 2 })).resolves.toBeUndefined();
  });
});

describe('one running timer per type per baby', () => {
  it('refuses a second active event of the same type', async () => {
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { typeId: 'sleep', rev: 1, active: 1 });

    // Two phones pressing start at the same moment: the database decides.
    await expect(
      insertEvent(babyId, userId, { typeId: 'sleep', rev: 2, active: 1 }),
    ).rejects.toThrow();
  });

  it('allows a different type to run at the same time', async () => {
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { typeId: 'sleep', rev: 1, active: 1 });
    await expect(
      insertEvent(babyId, userId, { typeId: 'nursing', rev: 2, active: 1 }),
    ).resolves.toBeUndefined();
  });

  it('allows the same type once the first one has finished', async () => {
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { typeId: 'sleep', rev: 1, active: null, endedAt: Date.now() });
    await expect(
      insertEvent(babyId, userId, { typeId: 'sleep', rev: 2, active: 1 }),
    ).resolves.toBeUndefined();
  });

  it('does not treat finished events as occupying the slot', async () => {
    // The index is on `active`, not on a null ended_at, or a second nappy
    // could never be recorded: those have no end time by nature.
    const { babyId, userId } = await setup();
    await insertEvent(babyId, userId, { typeId: 'diaper', rev: 1 });
    await expect(insertEvent(babyId, userId, { typeId: 'diaper', rev: 2 })).resolves.toBeUndefined();
  });
});

describe('active stays consistent with the end and deletion times', () => {
  it('refuses an active event that already has an end time', async () => {
    const { babyId, userId } = await setup();
    await expect(
      insertEvent(babyId, userId, { active: 1, endedAt: Date.now() }),
    ).rejects.toThrow();
  });

  it('refuses an active event that has been deleted', async () => {
    const { babyId, userId } = await setup();
    await expect(
      insertEvent(babyId, userId, { active: 1, deletedAt: Date.now() }),
    ).rejects.toThrow();
  });

  it('refuses to end an event without clearing the active flag', async () => {
    const { babyId, userId } = await setup();
    const id = crypto.randomUUID();
    await insertEvent(babyId, userId, { id, active: 1 });

    await expect(
      env.DB.prepare('UPDATE events SET ended_at = ? WHERE id = ?').bind(Date.now(), id).run(),
    ).rejects.toThrow();
  });

  it('accepts ending an event when the flag is cleared in the same statement', async () => {
    const { babyId, userId } = await setup();
    const id = crypto.randomUUID();
    await insertEvent(babyId, userId, { id, active: 1 });

    await expect(
      env.DB.prepare('UPDATE events SET ended_at = ?, active = NULL WHERE id = ?')
        .bind(Date.now(), id)
        .run(),
    ).resolves.toBeDefined();
  });
});
