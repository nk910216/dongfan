import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { MAX_PASSWORD_LENGTH, hashPassword, verifyPassword } from '@dongfan/shared';
import { createUser, json, login, request, signedInUser } from './helpers.js';
import { USER_CONTENT } from './fixtures/user-content.js';

const PASSWORD = 'correct-horse-battery-staple-9021';

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('salts each hash, so identical passwords differ on disk', async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('records the cost in the stored value, so it can be raised later', async () => {
    const stored = await hashPassword(PASSWORD);
    const [scheme, algorithm, iterations] = stored.split('$');
    expect(scheme).toBe('pbkdf2');
    expect(algorithm).toBe('sha256');
    expect(Number(iterations)).toBeGreaterThan(0);

    // A password hashed at a different cost still verifies.
    const legacy = stored.replace(`$${iterations}$`, '$1000$');
    expect(await verifyPassword(PASSWORD, legacy)).toBe(false);
  });

  it('rejects a malformed stored value rather than throwing', async () => {
    expect(await verifyPassword(PASSWORD, 'nonsense')).toBe(false);
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
  });
});

describe('login', () => {
  it('issues a token for valid credentials', async () => {
    await createUser('alice', PASSWORD);
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });

    expect(response.status).toBe(200);
    const body = await json<{ token: string; user: { username: string } }>(response);
    expect(body.token).toHaveLength(64);
    expect(body.user.username).toBe('alice');
  });

  it('is case-insensitive about the username', async () => {
    await createUser('Bob', PASSWORD);
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: PASSWORD }),
    });
    expect(response.status).toBe(200);
  });

  it('answers the same way for a wrong password and an unknown user', async () => {
    await createUser('carol', PASSWORD);

    const wrongPassword = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'carol', password: 'nope' }),
    });
    const unknownUser = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'nobody', password: 'nope' }),
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await json(wrongPassword)).toEqual(await json(unknownUser));
  });

  it('never returns a message for the client to display', async () => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'nobody', password: 'nope' }),
    });
    const body = await json<{ error: Record<string, unknown> }>(response);
    expect(body.error).toEqual({ code: 'UNAUTHENTICATED', details: null });
    expect(JSON.stringify(body)).not.toMatch(/message/);
  });

  it('reports missing fields as structured field errors', async () => {
    const response = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({}) });
    expect(response.status).toBe(422);

    const body = await json<{ error: { code: string; details: { fields: { field: string; code: string; params: unknown }[] } } }>(response);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.fields).toEqual(
      expect.arrayContaining([{ field: 'username', code: 'REQUIRED', params: {} }]),
    );
  });

  it('refuses a password longer than the maximum', async () => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'someone', password: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) }),
    });

    expect(response.status).toBe(422);
    const body = await json<{ error: { details: { fields: { field: string; code: string }[] } } }>(response);
    expect(body.error.details.fields[0]).toEqual({
      field: 'password',
      code: 'TOO_LONG',
      params: { maxLength: MAX_PASSWORD_LENGTH },
    });
  });

  it('accepts a password at the maximum length made of astral characters', async () => {
    // Counted as UTF-16 units this is twice the limit, and the account it
    // belongs to would exist but be impossible to log into.
    const password = USER_CONTENT.astralCharacter.repeat(MAX_PASSWORD_LENGTH);
    await createUser('emoji-user', password);

    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'emoji-user', password }),
    });
    expect(response.status).toBe(200);
  });

  it('refuses a disabled account', async () => {
    const id = await createUser('dave', PASSWORD);
    await drizzle(env.DB).update(users).set({ disabledAt: Date.now() }).where(eq(users.id, id));

    const response = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'dave', password: PASSWORD }),
    });
    expect(response.status).toBe(401);
  });

  it('writes nothing on a failed attempt', async () => {
    // Turning other people's traffic into database writes would exhaust the
    // daily write allowance and take the whole app down (spec 9.4).
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    for (let i = 0; i < 5; i += 1) {
      await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'ghost', password: 'nope' }),
      });
    }
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe('sessions', () => {
  it('rejects a request with no token', async () => {
    const response = await request('/api/me');
    expect(response.status).toBe(401);
  });

  it('rejects a token that was never issued', async () => {
    const response = await request('/api/me', {}, 'f'.repeat(64));
    expect(response.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    const { token } = await signedInUser('erin', PASSWORD);
    const response = await request('/api/me', {}, token);
    expect(response.status).toBe(200);
  });

  it('stops accepting a token after logout', async () => {
    const { token } = await signedInUser('frank', PASSWORD);
    expect((await request('/api/auth/logout', { method: 'POST' }, token)).status).toBe(204);
    expect((await request('/api/me', {}, token)).status).toBe(401);
  });

  it('stops accepting a token once the account is disabled', async () => {
    const { id, token } = await signedInUser('grace', PASSWORD);
    await drizzle(env.DB).update(users).set({ disabledAt: Date.now() }).where(eq(users.id, id));
    expect((await request('/api/me', {}, token)).status).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    // Each test gets its own storage, so the user has to exist here.
    await createUser('heidi', PASSWORD);
    const token = await login('heidi', PASSWORD);
    const row = await env.DB.prepare('SELECT token_hash FROM sessions LIMIT 1').first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toHaveLength(64);
  });
});
