import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { babyMembers, events } from '../db/schema.js';
import { fail } from '../lib/errors.js';
import type { Env } from '../lib/types.js';

/**
 * Permission checks live here and nowhere else.
 *
 * Repeating them inside handlers is how one endpoint ends up without one
 * (spec 6.4, 9.5).
 */

async function membership(
  db: Env['Variables']['db'],
  userId: string,
  babyId: string,
): Promise<'owner' | 'member' | null> {
  const rows = await db
    .select({ role: babyMembers.role })
    .from(babyMembers)
    .where(and(eq(babyMembers.userId, userId), eq(babyMembers.babyId, babyId)))
    .limit(1);

  const role = rows[0]?.role;
  return role === 'owner' || role === 'member' ? role : null;
}

/** For routes whose path carries the baby id. */
export function requireBabyAccess(param = 'babyId') {
  return createMiddleware<Env>(async (c, next) => {
    const babyId = c.req.param(param);
    if (!babyId) return fail(c, 'NOT_FOUND');

    const role = await membership(c.get('db'), c.get('user').id, babyId);
    // 404 rather than 403: telling a stranger that an id exists is itself
    // information they should not have.
    if (!role) return fail(c, 'NOT_FOUND');

    c.set('babyId', babyId);
    c.set('role', role);
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

    const role = await membership(db, c.get('user').id, babyId);
    if (!role) return fail(c, 'NOT_FOUND');

    c.set('babyId', babyId);
    c.set('role', role);
    await next();
  });
}

/** Owner-only actions: invites, membership changes, editing the baby. */
export const requireOwner = createMiddleware<Env>(async (c, next) => {
  if (c.get('role') !== 'owner') return fail(c, 'FORBIDDEN');
  await next();
});
