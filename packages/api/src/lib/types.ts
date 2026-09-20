import type { drizzle } from 'drizzle-orm/d1';

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
};

export type SessionUser = { id: string; username: string };

/** The fields every event route needs to interpret a timestamp (spec 5.3). */
export type Baby = {
  id: string;
  nickname: string;
  birthDate: string;
  timezone: string;
};

export type Variables = {
  db: ReturnType<typeof drizzle>;
  user: SessionUser;
  /** Set by the baby permission middleware (spec 6.4). */
  babyId: string;
  role: 'owner' | 'member';
  baby: Baby;
};

export type Env = { Bindings: Bindings; Variables: Variables };
