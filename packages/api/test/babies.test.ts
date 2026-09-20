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

  it('rejects a timezone this version has not been reasoned about', async () => {
    const { token } = await signedInUser('parent', PASSWORD);

    // Real zones too, not just nonsense: the date rules assume no daylight
    // saving, so accepting an arbitrary one would break them quietly.
    for (const timezone of ['Mars/Olympus', 'America/New_York', 'Europe/London']) {
      const response = await request(
        '/api/babies',
        { method: 'POST', body: JSON.stringify({ nickname: 'X', gender: 'other', birthDate: '2026-03-08', timezone }) },
        token,
      );
      expect(response.status, timezone).toBe(422);
      const body = await json<{ error: { details: { fields: { field: string }[] } } }>(response);
      expect(body.error.details.fields[0]?.field).toBe('timezone');
    }
  });

  it('rejects a birth date that matches the pattern but is not a day', async () => {
    const { token } = await signedInUser('parent', PASSWORD);

    for (const birthDate of ['2026-02-31', '2026-13-01', '2026-00-10', String(Date.now())]) {
      const response = await request(
        '/api/babies',
        { method: 'POST', body: JSON.stringify({ nickname: 'X', gender: 'other', birthDate }) },
        token,
      );
      expect(response.status, birthDate).toBe(422);
    }
  });

  it('rejects a birth date in the future or implausibly far past', async () => {
    const { token } = await signedInUser('parent', PASSWORD);

    for (const birthDate of ['2099-01-01', '1899-12-31']) {
      const response = await request(
        '/api/babies',
        { method: 'POST', body: JSON.stringify({ nickname: 'X', gender: 'other', birthDate }) },
        token,
      );
      expect(response.status, birthDate).toBe(422);
    }
  });
});

describe('timezone cannot be edited', () => {
  it('ignores a timezone sent to the update endpoint', async () => {
    const { token } = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(token);

    // Changing it would invalidate the stored local_date of every event, so
    // the field is absent from the schema rather than merely discouraged.
    const response = await request(
      `/api/babies/${babyId}`,
      { method: 'PATCH', body: JSON.stringify({ timezone: 'America/New_York' }) },
      token,
    );

    // Nothing recognised in the body, so there is nothing to change.
    expect(response.status).toBe(422);

    const baby = await json<{ timezone: string }>(await request(`/api/babies/${babyId}`, {}, token));
    expect(baby.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('still allows editing the fields that are safe to change', async () => {
    const { token } = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(token);

    const response = await request(
      `/api/babies/${babyId}`,
      { method: 'PATCH', body: JSON.stringify({ nickname: 'Renamed', timezone: 'America/New_York' }) },
      token,
    );
    expect(response.status).toBe(200);

    const baby = await json<{ nickname: string; timezone: string }>(response);
    expect(baby.nickname).toBe('Renamed');
    expect(baby.timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('rejects an impossible birth date on update too', async () => {
    const { token } = await signedInUser('owner', PASSWORD);
    const babyId = await createBaby(token);

    const response = await request(
      `/api/babies/${babyId}`,
      { method: 'PATCH', body: JSON.stringify({ birthDate: '2026-02-31' }) },
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

describe('creating the same baby twice', () => {
  it('returns the one that is there rather than making another', async () => {
    const { token } = await signedInUser();
    const id = crypto.randomUUID();
    const body = { id, nickname: 'First', gender: 'other', birthDate: '2026-03-08' };

    const first = await request('/api/babies', { method: 'POST', body: JSON.stringify(body) }, token);
    expect(first.status).toBe(201);

    // The response to the first was lost and the parent pressed again. A
    // duplicate baby is worse than a duplicate event: nothing can merge
    // them, and every record afterwards goes to whichever one the app
    // happens to pick.
    const second = await request('/api/babies', { method: 'POST', body: JSON.stringify(body) }, token);
    expect(second.status).toBe(200);
    expect((await json<{ id: string }>(second)).id).toBe(id);

    const me = await json<{ babies: unknown[] }>(await request('/api/me', {}, token));
    expect(me.babies).toHaveLength(1);
  });

  it('does not let the second attempt rewrite the first', async () => {
    const { token } = await signedInUser();
    const id = crypto.randomUUID();

    await request('/api/babies', {
      method: 'POST',
      body: JSON.stringify({ id, nickname: 'First', gender: 'other', birthDate: '2026-03-08' }),
    }, token);

    const again = await request('/api/babies', {
      method: 'POST',
      body: JSON.stringify({ id, nickname: 'Changed', gender: 'male', birthDate: '2026-01-01' }),
    }, token);

    expect((await json<{ nickname: string }>(again)).nickname).toBe('First');
  });

  it('refuses an id belonging to a family the caller is not in', async () => {
    const owner = await signedInUser('owner', 'a-long-enough-password-here');
    const id = crypto.randomUUID();
    await request('/api/babies', {
      method: 'POST',
      body: JSON.stringify({ id, nickname: 'Theirs', gender: 'other', birthDate: '2026-03-08' }),
    }, owner.token);

    const stranger = await signedInUser('stranger', 'another-long-password-here');
    const response = await request('/api/babies', {
      method: 'POST',
      body: JSON.stringify({ id, nickname: 'Mine', gender: 'other', birthDate: '2026-03-08' }),
    }, stranger.token);

    // Answering with the stored baby would hand over another family's
    // record to anyone who guessed an id (spec 5.8).
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe('ID_CONFLICT');
    expect(text).not.toContain('Theirs');
  });

  it('still works without an id, for a caller that does not need one', async () => {
    const { token } = await signedInUser();
    const response = await request('/api/babies', {
      method: 'POST',
      body: JSON.stringify({ nickname: 'First', gender: 'other', birthDate: '2026-03-08' }),
    }, token);

    expect(response.status).toBe(201);
    expect((await json<{ id: string }>(response)).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
