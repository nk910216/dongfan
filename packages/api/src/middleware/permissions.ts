import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { babies, babyMembers, events } from '../db/schema.js';
import { fail } from '../lib/errors.js';
import type { Baby, Env } from '../lib/types.js';

/**
 * Permission checks live here and nowhere else.
 *
 * Repeating them inside handlers is how one endpoint ends up without one
 * (spec 6.4, 9.5).
 */

type Access = { role: 'owner' | 'member'; baby: Baby };

/**
 * Membership and the baby record in one query.
 *
 * Every event route needs the timezone and the birth date to validate a
 * timestamp, and joining them onto a lookup that already has to happen keeps
 * the query budget flat (spec 4.2).
 */
async function access(
  db: Env['Variables']['db'],
  userId: string,
  babyId: string,
): Promise<Access | null> {
  const rows = await db
    .select({
      role: babyMembers.role,
      id: babies.id,
      nickname: babies.nickname,
      birthDate: babies.birthDate,
      timezone: babies.timezone,
    })
    .from(babyMembers)
    .innerJoin(babies, eq(babies.id, babyMembers.babyId))
    .where(and(eq(babyMembers.userId, userId), eq(babyMembers.babyId, babyId)))
    .limit(1);

  const row = rows[0];
  if (!row || (row.role !== 'owner' && row.role !== 'member')) return null;

  return {
    role: row.role,
    baby: { id: row.id, nickname: row.nickname, birthDate: row.birthDate, timezone: row.timezone },
  };
}

/** For routes whose path carries the baby id. */
export function requireBabyAccess(param = 'babyId') {
  return createMiddleware<Env>(async (c, next) => {
    const babyId = c.req.param(param);
    if (!babyId) return fail(c, 'NOT_FOUND');

    const found = await access(c.get('db'), c.get('user').id, babyId);
    // 404 rather than 403: telling a stranger that an id exists is itself
    // information they should not have.
    if (!found) return fail(c, 'NOT_FOUND');

    c.set('babyId', babyId);
    c.set('role', found.role);
    c.set('baby', found.baby);
    await next();
  });
}

/**
 * For routes that name a resource directly, where the baby has to be looked
 * up first. A different shape from requireBabyAccess, hence a separate
 * middleware rather than a flag.
 */
export function requireEventAccess(param = 'eventId') {
  return createMiddleware<Env>(async (c, next) => {
    const eventId = c.req.param(param);
    if (!eventId) return fail(c, 'NOT_FOUND');

    const db = c.get('db');
    const rows = await db
      .select({ babyId: events.babyId })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    const babyId = rows[0]?.babyId;
    if (!babyId) return fail(c, 'NOT_FOUND');

    const found = await access(db, c.get('user').id, babyId);
    if (!found) return fail(c, 'NOT_FOUND');

    c.set('babyId', babyId);
    c.set('role', found.role);
    c.set('baby', found.baby);
    await next();
  });
}

/** Owner-only actions: invites, membership changes, editing the baby. */
export const requireOwner = createMiddleware<Env>(async (c, next) => {
  if (c.get('role') !== 'owner') return fail(c, 'FORBIDDEN');
  await next();
});
