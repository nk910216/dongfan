import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createBabyRequest, updateBabyRequest,
  DEFAULT_TIMEZONE, SUPPORTED_TIMEZONES, isPlausibleBirthDate,
} from '@dongfan/shared';
import { babies, babyMembers } from '../db/schema.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import { requireBabyAccess, requireOwner } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

export const babyRoutes = new Hono<Env>();

const SUPPORTED: readonly string[] = SUPPORTED_TIMEZONES;

/**
 * Only the timezones this version has been reasoned about.
 *
 * Accepting an arbitrary IANA name would look generous and quietly break the
 * date rules: the splitting logic assumes no daylight saving (spec 5.3).
 */
function isSupportedTimezone(timezone: string): boolean {
  return SUPPORTED.includes(timezone);
}

babyRoutes.post('/', async (c) => {
  const parsed = createBabyRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const userId = c.get('user').id;

  // Idempotency first, as for events (spec 5.8). A creation whose response
  // was lost gets pressed again, and without this the second press makes a
  // second baby -- which, unlike a duplicate event, nothing can merge.
  //
  // Scoped to membership, not to the id alone: answering with a baby the
  // caller has no claim on would hand over another family's record.
  if (parsed.data.id) {
    const existing = await db.select().from(babies).where(eq(babies.id, parsed.data.id)).limit(1);
    const baby = existing[0];
    if (baby) {
      const mine = await db
        .select({ role: babyMembers.role })
        .from(babyMembers)
        .where(and(eq(babyMembers.babyId, baby.id), eq(babyMembers.userId, userId)))
        .limit(1);

      if (mine.length === 0) return fail(c, 'ID_CONFLICT');
      return c.json({ ...baby, role: mine[0]?.role }, 200);
    }
  }

  const timezone = parsed.data.timezone ?? DEFAULT_TIMEZONE;
  if (!isSupportedTimezone(timezone)) {
    return failValidation(c, [
      { field: 'timezone', code: 'INVALID_ENUM', params: { allowed: SUPPORTED.join(',') } },
    ]);
  }

  // The pattern alone accepts 2026-02-31, which is not a day.
  if (!isPlausibleBirthDate(parsed.data.birthDate, Date.now(), timezone)) {
    return failValidation(c, [{ field: 'birthDate', code: 'INVALID_FORMAT', params: {} }]);
  }

  const now = Date.now();
  const id = parsed.data.id ?? crypto.randomUUID();

  // The creator becomes the first owner. There is no created_by column: the
  // role carries that meaning, and one source of truth avoids the two
  // disagreeing (spec 4).
  await db.batch([
    db.insert(babies).values({
      id,
      nickname: parsed.data.nickname,
      gender: parsed.data.gender,
      birthDate: parsed.data.birthDate,
      timezone,
      createdAt: now,
    }),
    db.insert(babyMembers).values({
      babyId: id,
      userId: c.get('user').id,
      role: 'owner',
      createdAt: now,
    }),
  ]);

  return c.json(
    {
      id,
      nickname: parsed.data.nickname,
      gender: parsed.data.gender,
      birthDate: parsed.data.birthDate,
      timezone,
      role: 'owner',
    },
    201,
  );
});

babyRoutes.get('/:babyId', requireBabyAccess(), async (c) => {
  const rows = await c
    .get('db')
    .select()
    .from(babies)
    .where(eq(babies.id, c.get('babyId')))
    .limit(1);

  const baby = rows[0];
  if (!baby) return fail(c, 'NOT_FOUND');
  return c.json({ ...baby, role: c.get('role') });
});

babyRoutes.patch('/:babyId', requireBabyAccess(), requireOwner, async (c) => {
  const parsed = updateBabyRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const patch = parsed.data;
  if (Object.keys(patch).length === 0) return fail(c, 'VALIDATION_FAILED', { fields: [] });

  if (patch.birthDate !== undefined) {
    const rows = await c.get('db').select({ timezone: babies.timezone }).from(babies)
      .where(eq(babies.id, c.get('babyId'))).limit(1);
    const timezone = rows[0]?.timezone ?? DEFAULT_TIMEZONE;
    if (!isPlausibleBirthDate(patch.birthDate, Date.now(), timezone)) {
      return failValidation(c, [{ field: 'birthDate', code: 'INVALID_FORMAT', params: {} }]);
    }
  }

  await c.get('db').update(babies).set(patch).where(eq(babies.id, c.get('babyId')));

  const rows = await c.get('db').select().from(babies).where(eq(babies.id, c.get('babyId'))).limit(1);
  return c.json(rows[0]);
});

babyRoutes.get('/:babyId/members', requireBabyAccess(), async (c) => {
  const members = await c
    .get('db')
    .select({ userId: babyMembers.userId, role: babyMembers.role, createdAt: babyMembers.createdAt })
    .from(babyMembers)
    .where(eq(babyMembers.babyId, c.get('babyId')));

  return c.json({ members });
});
