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

export type EventBody = {
  id?: string;
  typeId: string;
  intent?: 'start_timer' | 'record';
  startedAt?: number;
  endedAt?: number | null;
  value?: number;
  note?: string;
  metadata?: Record<string, string>;
  tagIds?: string[];
};

export function newId(): string {
  return crypto.randomUUID();
}

/** Posts an event the way the app does, filling in the dull parts. */
export function postEvent(token: string, babyId: string, body: EventBody): Promise<Response> {
  return request(
    `/api/babies/${babyId}/events`,
    {
      method: 'POST',
      body: JSON.stringify({
        id: body.id ?? newId(),
        intent: 'record',
        startedAt: Date.now(),
        endedAt: null,
        ...body,
      }),
    },
    token,
  );
}

export type StoredEvent = {
  id: string;
  babyId: string;
  typeId: string;
  startedAt: number;
  endedAt: number | null;
  localDate: string;
  value: number;
  note: string;
  metadata: Record<string, string>;
  version: number;
  rev: number;
  active: boolean;
  deletedAt: number | null;
  tagIds: string[];
};

/** Posts an event and fails loudly if it did not land, so tests read shorter. */
export async function createEvent(
  token: string,
  babyId: string,
  body: EventBody,
): Promise<StoredEvent> {
  const response = await postEvent(token, babyId, body);
  if (response.status !== 201) {
    throw new Error(`Expected 201, got ${response.status}: ${await response.text()}`);
  }
  return json<StoredEvent>(response);
}

export function patchEvent(
  token: string,
  eventId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request(`/api/events/${eventId}`, { method: 'PATCH', body: JSON.stringify(body) }, token);
}

export function deleteEvent(token: string, eventId: string, version: number): Promise<Response> {
  return request(
    `/api/events/${eventId}`,
    { method: 'DELETE', body: JSON.stringify({ version }) },
    token,
  );
}

export async function createTag(token: string, babyId: string, name: string): Promise<string> {
  const response = await request(
    `/api/babies/${babyId}/tags`,
    { method: 'POST', body: JSON.stringify({ name }) },
    token,
  );
  return (await json<{ id: string }>(response)).id;
}

export type SummaryBody = {
  date: string;
  types: {
    typeId: string;
    lastStartedAt: number;
    lastValue: number;
    activeEventId: string | null;
    activeStartedAt: number | null;
    activeVersion: number | null;
  }[];
  today: {
    totalBottleMl: number;
    diaper: { pee: number; poo: number; both: number; unknown: number; total: number };
  };
  lastFeedAt: number | null;
};

export async function summary(token: string, babyId: string): Promise<SummaryBody> {
  return json<SummaryBody>(await request(`/api/babies/${babyId}/events/summary`, {}, token));
}
