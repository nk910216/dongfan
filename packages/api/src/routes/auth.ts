import { and, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { loginRequest } from '@dongfan/shared';
import { verifyPassword } from '@dongfan/shared';
import { generateToken, hashToken } from '@dongfan/shared';
import { sessionExpiry } from '../auth/session.js';
import { sessions, users } from '../db/schema.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import type { Env } from '../lib/types.js';

export const authRoutes = new Hono<Env>();

/**
 * There is no registration endpoint by design; accounts come from the CLI
 * (spec 9.1).
 *
 * A failed attempt writes nothing. Recording failures would turn anyone's
 * traffic into database writes, and the free plan stops serving every query
 * for the rest of the day once the write allowance is gone (spec 9.4).
 */
authRoutes.post('/login', async (c) => {
  const parsed = loginRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const rows = await db
    .select({ id: users.id, username: users.username, hash: users.passwordHash, disabledAt: users.disabledAt })
    .from(users)
    // Compare the same way the unique index is built, or an account
    // created as "Bob" cannot be reached by typing "bob".
    .where(sql`lower(${users.username}) = lower(${parsed.data.username})`)
    .limit(1);

  const user = rows[0];
  // Verify even when the user is missing, so a wrong username and a wrong
  // password take the same time to answer.
  const hash = user?.hash ?? 'pbkdf2$sha256$1$AAAA$AAAA';
  const ok = await verifyPassword(parsed.data.password, hash);
  if (!user || !ok || user.disabledAt !== null) return fail(c, 'UNAUTHENTICATED');

  const now = Date.now();
  const token = generateToken();

  // Cheap housekeeping while we are already writing: no scheduled job needed.
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, now)));
  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: await hashToken(token),
    expiresAt: sessionExpiry(now),
    createdAt: now,
  });

  return c.json({ token, user: { id: user.id, username: user.username } });
});

authRoutes.post('/logout', async (c) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    await c.get('db').delete(sessions).where(eq(sessions.tokenHash, await hashToken(token)));
  }
  return c.body(null, 204);
});
