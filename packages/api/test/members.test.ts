import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken, normaliseInviteCode } from '@dongfan/shared';
import type { BabyDto, InviteDto, MembersDto } from '@dongfan/shared';
import { inviteCodes } from '../src/db/schema.js';
import { resetThrottle } from '../src/lib/throttle.js';
import { createBaby, json, request, signedInUser } from './helpers.js';

/**
 * Letting the other parent in (spec 6.5).
 *
 * A code is every record of a child, so the ways it must fail are the
 * point: once only, an hour only, for one baby only, and never reusable by
 * somebody who was let in and then removed. Each of those has a way of
 * being written that looks right and is not, and spec 4.3 names them.
 */

let owner: { token: string; id: string };
let babyId: string;

async function inviteTo(baby: string, token: string): Promise<InviteDto> {
  const response = await request(`/api/babies/${baby}/invite`, { method: 'POST' }, token);
  expect(response.status).toBe(201);
  return json<InviteDto>(response);
}

function join(code: string, token: string): Promise<Response> {
  return request('/api/babies/join', { method: 'POST', body: JSON.stringify({ code }) }, token);
}

function members(baby: string, token: string): Promise<Response> {
  return request(`/api/babies/${baby}/members`, {}, token);
}

/** Pushes an invitation's expiry into the past, as an hour passing would. */
async function expire(code: string): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .update(inviteCodes)
    .set({ expiresAt: Date.now() - 1 })
    .where(eq(inviteCodes.codeHash, await hashToken(normaliseInviteCode(code))));
}

beforeEach(async () => {
  resetThrottle();
  const user = await signedInUser('owner', 'a-sufficiently-long-password');
  owner = { token: user.token, id: user.id };
  babyId = await createBaby(owner.token, { birthDate: '2026-03-08' });
});

describe('making a code', () => {
  it('hands it back once and keeps only its digest', async () => {
    const invite = await inviteTo(babyId, owner.token);

    expect(invite.expiresAt).toBeGreaterThan(Date.now());
    // An hour, give or take the time this test took.
    expect(invite.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

    const db = drizzle(env.DB);
    const rows = await db.select().from(inviteCodes).where(eq(inviteCodes.babyId, babyId));

    // Nothing anywhere holds the code itself. Losing it means making
    // another, which is the right trade for a value that opens every
    // record of a child (spec 6.5).
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(normaliseInviteCode(invite.code));
    expect(rows[0]?.codeHash).toBe(await hashToken(normaliseInviteCode(invite.code)));
  });

  it('carries at least 128 bits, in symbols nobody misreads', async () => {
    const code = normaliseInviteCode((await inviteTo(babyId, owner.token)).code);

    // Thirty symbols from an alphabet of thirty-two is 150 bits. The
    // alphabet leaves out I, L, O and U, which are the ones read back
    // wrongly off a screen.
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{30}$/);
  });

  it('is a different code every time', async () => {
    const first = await inviteTo(babyId, owner.token);
    const second = await inviteTo(babyId, owner.token);
    expect(first.code).not.toBe(second.code);
  });

  it('is refused to a member who is not the owner', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    const response = await request(`/api/babies/${babyId}/invite`, { method: 'POST' }, other.token);
    expect(response.status).toBe(403);
  });

  it('is refused to somebody with no claim on the baby at all', async () => {
    const stranger = await signedInUser('stranger', 'a-sufficiently-long-password');
    const response = await request(`/api/babies/${babyId}/invite`, { method: 'POST' }, stranger.token);
    // 404, not 403: that an id exists is itself something they should not
    // be able to find out (spec 6.4).
    expect(response.status).toBe(404);
  });
});

describe('using one', () => {
  it('takes the person in, as a member', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    const invite = await inviteTo(babyId, owner.token);

    const response = await join(invite.code, other.token);
    expect(response.status).toBe(201);
    expect((await json<BabyDto>(response)).id).toBe(babyId);

    const listed = await json<MembersDto>(await members(babyId, other.token));
    expect(listed.members.map((m) => m.role).sort()).toEqual(['member', 'owner']);
    expect(listed.members.map((m) => m.username).sort()).toEqual(['member', 'owner']);
  });

  it('accepts it however it was typed back', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    const invite = await inviteTo(babyId, owner.token);

    // Lower case, spaces for dashes, and the three symbols people
    // substitute without noticing. Refusing any of these is a phone call
    // at three in the morning.
    const retyped = invite.code
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');

    expect((await join(retyped, other.token)).status).toBe(201);
  });

  it('works once and never again', async () => {
    const first = await signedInUser('first', 'a-sufficiently-long-password');
    const second = await signedInUser('second', 'a-sufficiently-long-password');
    const invite = await inviteTo(babyId, owner.token);

    expect((await join(invite.code, first.token)).status).toBe(201);
    expect((await join(invite.code, second.token)).status).toBe(404);

    const listed = await json<MembersDto>(await members(babyId, owner.token));
    expect(listed.members).toHaveLength(2);
  });

  it('is refused an hour after it was made', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    const invite = await inviteTo(babyId, owner.token);
    await expire(invite.code);

    expect((await join(invite.code, other.token)).status).toBe(404);
    expect((await json<MembersDto>(await members(babyId, owner.token))).members).toHaveLength(1);
  });

  it('cannot be reused by somebody who was let in and then removed', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    const invite = await inviteTo(babyId, owner.token);
    await join(invite.code, other.token);

    await request(`/api/babies/${babyId}/members/${other.id}`, { method: 'DELETE' }, owner.token);

    // The guard that fails here is the tempting one: `used_by = :uid` says
    // this person once used the code, not that this request consumed it
    // (spec 4.3).
    expect((await join(invite.code, other.token)).status).toBe(404);
    expect((await members(babyId, other.token)).status).toBe(404);
  });

  it('lets somebody who is already a member spend it without breaking', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    // The unique index would otherwise throw and take the whole batch
    // with it, leaving the code unusable and nobody the wiser.
    expect((await join((await inviteTo(babyId, owner.token)).code, other.token)).status).toBe(201);
    expect((await json<MembersDto>(await members(babyId, owner.token))).members).toHaveLength(2);
  });

  it('is not a way into a different baby', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    const theirs = await createBaby(other.token, { nickname: 'Theirs', birthDate: '2026-03-08' });
    const invite = await inviteTo(babyId, owner.token);

    // The baby comes from the invitation row, never from the request, so
    // there is nothing here to point somewhere else.
    const response = await join(invite.code, other.token);
    expect((await json<BabyDto>(response)).id).toBe(babyId);
    expect((await json<MembersDto>(await members(theirs, other.token))).members).toHaveLength(1);
  });

  it.each([
    ['nothing like a code', 'hello'],
    ['the right shape, never issued', 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ'],
    ['symbols the alphabet does not use', 'UUUUU-UUUUU-UUUUU-UUUUU-UUUUU-UUUUU'],
  ])('answers the same way to %s', async (_name, code) => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    expect((await join(code, other.token)).status).toBe(404);
  });

  it('refuses to keep answering a run of guesses', async () => {
    const guesser = await signedInUser('guesser', 'a-sufficiently-long-password');

    let sawRateLimit = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await join('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', guesser.token);
      if (response.status === 429) {
        sawRateLimit = true;
        break;
      }
    }

    // Not the defence -- the 150 bits are. This only stops a loop from one
    // place being free, and it writes nothing to do it (spec 9.4).
    expect(sawRateLimit).toBe(true);
  });

  it('needs a session like everything else', async () => {
    expect((await join('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'not-a-token')).status).toBe(401);
  });
});

describe('removing somebody', () => {
  it('lets the owner take a member out', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    const response = await request(
      `/api/babies/${babyId}/members/${other.id}`, { method: 'DELETE' }, owner.token,
    );
    expect(response.status).toBe(204);
    expect((await members(babyId, other.token)).status).toBe(404);
  });

  it('lets somebody leave on their own', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    const response = await request(
      `/api/babies/${babyId}/members/${other.id}`, { method: 'DELETE' }, other.token,
    );
    expect(response.status).toBe(204);
  });

  it('does not let a member take anybody else out', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    const response = await request(
      `/api/babies/${babyId}/members/${owner.id}`, { method: 'DELETE' }, other.token,
    );
    expect(response.status).toBe(403);
    expect((await json<MembersDto>(await members(babyId, owner.token))).members).toHaveLength(2);
  });

  it('will not let the last owner go', async () => {
    const other = await signedInUser('member', 'a-sufficiently-long-password');
    await join((await inviteTo(babyId, owner.token)).code, other.token);

    // A baby with no owner can never be invited to again and its details
    // can never be corrected: there would be nobody left who is allowed
    // to.
    const response = await request(
      `/api/babies/${babyId}/members/${owner.id}`, { method: 'DELETE' }, owner.token,
    );
    expect(response.status).toBe(403);
    expect((await json<MembersDto>(await members(babyId, owner.token))).members).toHaveLength(2);
  });

  it('refuses a stranger without saying whether the baby exists', async () => {
    const stranger = await signedInUser('stranger', 'a-sufficiently-long-password');
    const response = await request(
      `/api/babies/${babyId}/members/${owner.id}`, { method: 'DELETE' }, stranger.token,
    );
    expect(response.status).toBe(404);
  });
});
