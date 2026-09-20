import { SESSION_TTL_MS } from '@dongfan/shared';

/** Ninety days, revocable by deleting the row (spec 9.2). */
export function sessionExpiry(now: number): number {
  return now + SESSION_TTL_MS;
}
