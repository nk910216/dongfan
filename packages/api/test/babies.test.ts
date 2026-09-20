import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE } from '@dongfan/shared';
import { createBaby, json, request, signedInUser } from './helpers.js';
import { USER_CONTENT } from './fixtures/user-content.js';

const PASSWORD = 'a-long-random-password-1234';

describe('creating a baby', () => {
  it('makes the creator an owner', async () => {
    const { id: userId, token } = await signedInUser('parent', PASSWORD);
    const babyId = await createBaby(token);

    const row = await env.DB.prepare('SELECT role FROM baby_members WHERE baby_id = ? AND user_id = ?')
      .bind(babyId, userId)
      .first<{ role: string }>();

    expect(row?.role).toBe('owner');
  });

  it('defaults the timezone rather than leaving it to the device', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    const babyId = await createBaby(token);

    const response = await request(`/api/babies/${babyId}`, {}, token);
    const baby = await json<{ timezone: string }>(response);
    expect(baby.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('rejects a timezone the runtime does not recognise', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    const response = await request(
      '/api/babies',
      {
        method: 'POST',
        body: JSON.stringify({ nickname: 'X', gender: 'other', birthDate: '2026-03-08', timezone: 'Mars/Olympus' }),
      },
      token,
    );

    expect(response.status).toBe(422);
    const body = await json<{ error: { details: { fields: { field: string }[] } } }>(response);
    expect(body.error.details.fields[0]?.field).toBe('timezone');
  });

  it('rejects a birth date that is not a calendar day', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    const response = await request(
      '/api/babies',
      { method: 'POST', body: JSON.stringify({ nickname: 'X', gender: 'other', birthDate: String(Date.now()) }) },
      token,
    );
    expect(response.status).toBe(422);
  });
});

describe('user-typed content', () => {
  it('stores and returns a Chinese nickname byte for byte', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    const babyId = await createBaby(token, { nickname: USER_CONTENT.nickname });

    const baby = await json<{ nickname: string }>(await request(`/api/babies/${babyId}`, {}, token));
    expect(baby.nickname).toBe(USER_CONTENT.nickname);

    // Straight out of the database too, in case a serialiser is helping.
    const row = await env.DB.prepare('SELECT nickname FROM babies WHERE id = ?')
      .bind(babyId)
      .first<{ nickname: string }>();
    expect(row?.nickname).toBe(USER_CONTENT.nickname);
  });

  it('keeps internal spacing and emoji intact', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    const babyId = await createBaby(token, { nickname: USER_CONTENT.nicknameWithSpaces });
    const baby = await json<{ nickname: string }>(await request(`/api/babies/${babyId}`, {}, token));
    expect(baby.nickname).toBe(USER_CONTENT.nicknameWithSpaces);
  });

  it('measures length in characters, not bytes', async () => {
    const { token } = await signedInUser('parent', PASSWORD);
    // Fifty characters is inside the limit; as UTF-8 it is a hundred and
    // fifty bytes, which a byte-based limit would refuse.
    const nickname = USER_CONTENT.nickname.repeat(25);
    expect(nickname.length).toBe(50);

    const response = await request(
      '/api/babies',
      { method: 'POST', body: JSON.stringify({ nickname, gender: 'other', birthDate: '2026-03-08' }) },
      token,
    );
    expect(response.status).toBe(201);
  });
});

describe('access control', () => {
  it('hides a baby from someone who is not a member', async () => {
    const owner = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(owner.token);
    const stranger = await signedInUser('stranger', PASSWORD);

    const response = await request(`/api/babies/${babyId}`, {}, stranger.token);
    // 404 rather than 403: confirming the id exists is itself a leak.
    expect(response.status).toBe(404);
  });

  it('lists only the babies a user can reach', async () => {
    const owner = await signedInUser('owner', PASSWORD);
    await createBaby(owner.token, { nickname: 'Mine' });
    const other = await signedInUser('other', PASSWORD);
    await createBaby(other.token, { nickname: 'Theirs' });

    const body = await json<{ babies: { nickname: string }[] }>(await request('/api/me', {}, owner.token));
    expect(body.babies.map((b) => b.nickname)).toEqual(['Mine']);
  });

  it('lets an owner edit the baby', async () => {
    const { token } = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(token);

    const response = await request(
      `/api/babies/${babyId}`,
      { method: 'PATCH', body: JSON.stringify({ nickname: USER_CONTENT.nickname }) },
      token,
    );
    expect(response.status).toBe(200);
    expect((await json<{ nickname: string }>(response)).nickname).toBe(USER_CONTENT.nickname);
  });

  it('refuses to let a plain member edit the baby', async () => {
    const owner = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(owner.token);
    const member = await signedInUser('member', PASSWORD);

    await env.DB.prepare('INSERT INTO baby_members (baby_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(babyId, member.id, 'member', Date.now())
      .run();

    // Visible, but not editable.
    expect((await request(`/api/babies/${babyId}`, {}, member.token)).status).toBe(200);
    const response = await request(
      `/api/babies/${babyId}`,
      { method: 'PATCH', body: JSON.stringify({ nickname: 'Renamed' }) },
      member.token,
    );
    expect(response.status).toBe(403);
  });

  it('shows both members once one is assigned', async () => {
    const owner = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(owner.token);
    const member = await signedInUser('member', PASSWORD);
    await env.DB.prepare('INSERT INTO baby_members (baby_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(babyId, member.id, 'member', Date.now())
      .run();

    const body = await json<{ members: { role: string }[] }>(
      await request(`/api/babies/${babyId}/members`, {}, owner.token),
    );
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.role).sort()).toEqual(['member', 'owner']);
  });
});
