import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createBabyRequest, joinBabyRequest, updateBabyRequest,
  DEFAULT_TIMEZONE, INVITE_CODE_TTL_MS, SUPPORTED_TIMEZONES,
  generateInviteCode, hashToken, isInviteCodeShaped, isPlausibleBirthDate, normaliseInviteCode,
} from '@dongfan/shared';
import type { InviteDto, MembersDto } from '@dongfan/shared';
import { babies, babyMembers, inviteCodes, users } from '../db/schema.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import { overLimit } from '../lib/throttle.js';
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
  // With the username, because the list exists to be read by a family and
  // a column of ids answers nothing they came to find out (spec 7.8).
  const rows = await c
    .get('db')
    .select({
      userId: babyMembers.userId,
      username: users.username,
      role: babyMembers.role,
      createdAt: babyMembers.createdAt,
    })
    .from(babyMembers)
    .innerJoin(users, eq(users.id, babyMembers.userId))
    .where(eq(babyMembers.babyId, c.get('babyId')));

  const members = rows.map((row) => ({
    ...row,
    role: row.role === 'owner' ? ('owner' as const) : ('member' as const),
  }));

  return c.json({ members } satisfies MembersDto);
});

/**
 * A one-time code, shown once.
 *
 * Only the digest is kept, so there is no reading it back afterwards --
 * losing it means making another one, which is the correct trade for a
 * value that opens every record of a child (spec 6.5).
 */
babyRoutes.post('/:babyId/invite', requireBabyAccess(), requireOwner, async (c) => {
  const code = generateInviteCode();
  const now = Date.now();
  const expiresAt = now + INVITE_CODE_TTL_MS;

  await c.get('db').insert(inviteCodes).values({
    id: crypto.randomUUID(),
    babyId: c.get('babyId'),
    // The normalised form, because that is what the other end will have
    // after the dashes and the capitals somebody typed are thrown away.
    codeHash: await hashToken(normaliseInviteCode(code)),
    expiresAt,
    usedAt: null,
    usedBy: null,
    createdBy: c.get('user').id,
    createdAt: now,
  });

  return c.json({ code, expiresAt } satisfies InviteDto, 201);
});

/**
 * Taking a member in, and using up the code, or neither.
 *
 * Both statements carry the same precondition -- unused and unexpired --
 * and the member is written *before* the code is consumed. Reversed, the
 * update would clear `used_at` out from under the insert's condition and
 * nobody would be added. Hanging the insert's guard on `used_by` instead
 * would be worse still: that only says somebody once used this code, so a
 * member who was removed could rejoin with the same one, expired or not
 * (spec 4.3).
 *
 * The baby comes from the invitation row, never from the request. A valid
 * code for one child must not be a way into another.
 */
const TAKE_MEMBER_IN = `
INSERT INTO baby_members (baby_id, user_id, role, created_at)
SELECT ic.baby_id, ?, 'member', ?
  FROM invite_codes ic
 WHERE ic.id = ? AND ic.used_at IS NULL AND ic.expires_at > ?
ON CONFLICT (user_id, baby_id) DO NOTHING`;

const CONSUME_CODE = `
UPDATE invite_codes SET used_at = ?, used_by = ?
 WHERE id = ? AND used_at IS NULL AND expires_at > ?`;

/**
 * How hard somebody may guess, per account.
 *
 * Not a security boundary and not treated as one: the boundary is the 150
 * bits in the code. This only stops a loop from one place being free, and
 * it writes nothing, because a brake that spends the day's database
 * allowance can be used to stop a parent recording a feed (spec 9.4).
 */
const JOIN_LIMIT = { attempts: 10, windowMs: 60 * 60 * 1000 };

babyRoutes.post('/join', async (c) => {
  const parsed = joinBabyRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const userId = c.get('user').id;
  if (overLimit(`join:${userId}`, JOIN_LIMIT)) return fail(c, 'RATE_LIMITED');

  const code = normaliseInviteCode(parsed.data.code);
  // Shaped wrongly is answered without a lookup: nothing that is not one of
  // ours can be in the table, and the answer is the same either way.
  if (!isInviteCodeShaped(code)) return fail(c, 'NOT_FOUND');

  const db = c.get('db');
  const now = Date.now();

  // Found by digest, on the unique index. What comes back is not trusted:
  // the two statements below carry their own conditions, so a code that
  // is used or expires between this read and them changes nothing.
  const found = await db
    .select({ id: inviteCodes.id, babyId: inviteCodes.babyId })
    .from(inviteCodes)
    .where(eq(inviteCodes.codeHash, await hashToken(code)))
    .limit(1);

  const invite = found[0];
  if (!invite) return fail(c, 'NOT_FOUND');

  const results = await c.env.DB.batch([
    c.env.DB.prepare(TAKE_MEMBER_IN).bind(userId, now, invite.id, now),
    c.env.DB.prepare(CONSUME_CODE).bind(now, userId, invite.id, now),
  ]);

  // The consume decides, by rows affected. Reading the row back to see
  // whether it looks used would answer a different question: whether
  // anybody used it, rather than whether this request did (spec 4.3).
  if ((results[1]?.meta.changes ?? 0) === 0) return fail(c, 'NOT_FOUND');

  const rows = await db.select().from(babies).where(eq(babies.id, invite.babyId)).limit(1);
  const baby = rows[0];
  if (!baby) return fail(c, 'NOT_FOUND');

  return c.json({ ...baby, role: 'member' }, 201);
});

/**
 * Removing somebody, or leaving.
 *
 * The last owner cannot go. A baby with no owner can never be invited to
 * again and its details can never be corrected -- there would be nobody
 * left who is allowed to. Guarded inside the statement rather than counted
 * first, so two owners leaving at the same moment cannot both be the one
 * who was allowed to.
 */
const REMOVE_MEMBER = `
DELETE FROM baby_members
 WHERE baby_id = ? AND user_id = ?
   AND (role <> 'owner'
        OR (SELECT COUNT(*) FROM baby_members m
             WHERE m.baby_id = ? AND m.role = 'owner') > 1)`;

babyRoutes.delete('/:babyId/members/:userId', requireBabyAccess(), async (c) => {
  const babyId = c.get('babyId');
  const target = c.req.param('userId') ?? '';

  // An owner may remove anybody; anybody may remove themselves. Written
  // here rather than as `requireOwner` because leaving is not an owner
  // action and the middleware has no way to say so (spec 6.4).
  if (target !== c.get('user').id && c.get('role') !== 'owner') return fail(c, 'FORBIDDEN');

  const result = await c.env.DB.prepare(REMOVE_MEMBER).bind(babyId, target, babyId).run();
  if ((result.meta.changes ?? 0) === 0) return fail(c, 'FORBIDDEN');

  return c.body(null, 204);
});
