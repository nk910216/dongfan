import { ApiFailure, NetworkFailure } from './api.js';

/**
 * Whether the server got it.
 *
 * Shared by everything that creates a record, because the rule is about the
 * request rather than about what was being made, and having it twice is how
 * one copy came to be missing (spec 6.1).
 *
 * The hazard both callers guard against is the same: a response that was
 * lost looks exactly like a refusal, but sending corrected content under
 * the same id afterwards gets the *stored* version back, and the correction
 * disappears with nothing on screen to say so.
 */

/**
 * The refusals that prove the server does not have the record.
 *
 * A whitelist, and a short one: these are the only answers a create handler
 * produces *after* its idempotency read-back. Reaching one of them means
 * the server looked for this id, did not find it, and went on to refuse the
 * content (spec 5.8).
 *
 * Everything else leaves the doubt where it was. A session that expired, a
 * rate limit, an account removed from the baby between the first attempt
 * and the retry -- none of them say anything about whether the first
 * attempt landed, and a 404 from losing access is not evidence that the
 * record is absent. Nor is a code this build has never seen.
 */
const PROVES_NOT_STORED = new Set([
  'VALIDATION_FAILED',
  'DAILY_LIMIT_EXCEEDED',
  'ACTIVE_TIMER_EXISTS',
  'ID_CONFLICT',
]);

export function provesNotStored(error: unknown): boolean {
  return error instanceof ApiFailure && PROVES_NOT_STORED.has(error.code);
}

/**
 * Whether a first attempt tells us nothing about what the server did.
 *
 * A request that never arrived and a server that fell over midway are the
 * same thing from here: the record may or may not be stored. Only asked
 * when there is no doubt yet -- a 404 on a first attempt really is a
 * refusal before any write, and freezing a form over it would be a lie.
 */
export function outcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NetworkFailure) return true;
  return error instanceof ApiFailure && error.status >= 500;
}
