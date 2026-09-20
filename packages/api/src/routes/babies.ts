import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createBabyRequest, updateBabyRequest, DEFAULT_TIMEZONE } from '@dongfan/shared';
import { babies, babyMembers } from '../db/schema.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import { requireBabyAccess, requireOwner } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

export const babyRoutes = new Hono<Env>();

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

babyRoutes.post('/', async (c) => {
  const parsed = createBabyRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const timezone = parsed.data.timezone ?? DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) {
    return failValidation(c, [{ field: 'timezone', code: 'INVALID_FORMAT', params: {} }]);
  }

  const db = c.get('db');
  const now = Date.now();
  const id = crypto.randomUUID();

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

  return c.json({ id, nickname: parsed.data.nickname, gender: parsed.data.gender, birthDate: parsed.data.birthDate, timezone }, 201);
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
  if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
    return failValidation(c, [{ field: 'timezone', code: 'INVALID_FORMAT', params: {} }]);
  }
  if (Object.keys(patch).length === 0) return fail(c, 'VALIDATION_FAILED', { fields: [] });

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
