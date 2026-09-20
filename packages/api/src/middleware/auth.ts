import { and, eq, gt, isNull } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { hashToken } from '@dongfan/shared';
import { sessions, users } from '../db/schema.js';
import { fail } from '../lib/errors.js';
import type { Env } from '../lib/types.js';

/**
 * Resolves the bearer token to a user.
 *
 * Every route except login sits behind this. A disabled account is rejected
 * here, so disabling a user takes effect on the next request rather than
 * whenever their session happens to expire (spec 9.1).
 */
export const requireSession = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return fail(c, 'UNAUTHENTICATED');

  const db = c.get('db');
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, await hashToken(token)),
        gt(sessions.expiresAt, Date.now()),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);

  const user = rows[0];
  if (!user) return fail(c, 'UNAUTHENTICATED');

  c.set('user', user);
  await next();
});
