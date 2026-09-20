import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { babies, babyMembers } from '../db/schema.js';
import type { Env } from '../lib/types.js';

export const meRoutes = new Hono<Env>();

/** The current user plus every baby they can reach, in one round trip. */
meRoutes.get('/', async (c) => {
  const user = c.get('user');

  const rows = await c
    .get('db')
    .select({
      id: babies.id,
      nickname: babies.nickname,
      gender: babies.gender,
      birthDate: babies.birthDate,
      timezone: babies.timezone,
      role: babyMembers.role,
    })
    .from(babyMembers)
    .innerJoin(babies, eq(babies.id, babyMembers.babyId))
    .where(eq(babyMembers.userId, user.id));

  return c.json({ user, babies: rows });
});
