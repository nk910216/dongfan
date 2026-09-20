import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { hashPassword } from '@dongfan/shared';
import { users } from '../src/db/schema.js';
import app from '../src/index.js';

/** Shorthand for driving the worker the way a client would. */
export async function request(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return app.fetch(new Request(`http://test${path}`, { ...init, headers }), env);
}

export async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function createUser(username: string, password: string): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username,
    passwordHash: await hashPassword(password),
    createdAt: Date.now(),
  });
  return id;
}

export async function login(username: string, password: string): Promise<string> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  const body = await json<{ token: string }>(response);
  return body.token;
}

/** A user with a session, ready to make authenticated calls. */
export async function signedInUser(username = 'parent', password = 'a-long-random-password'): Promise<{
  id: string;
  token: string;
}> {
  const id = await createUser(username, password);
  return { id, token: await login(username, password) };
}

export async function createBaby(token: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await request(
    '/api/babies',
    {
      method: 'POST',
      body: JSON.stringify({ nickname: 'Test', gender: 'other', birthDate: '2026-03-08', ...overrides }),
    },
    token,
  );
  const body = await json<{ id: string }>(response);
  return body.id;
}
