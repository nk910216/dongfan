import type { drizzle } from 'drizzle-orm/d1';

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
};

export type SessionUser = { id: string; username: string };

export type Variables = {
  db: ReturnType<typeof drizzle>;
  user: SessionUser;
  /** Set by the baby permission middleware (spec 6.4). */
  babyId: string;
  role: 'owner' | 'member';
};

export type Env = { Bindings: Bindings; Variables: Variables };
