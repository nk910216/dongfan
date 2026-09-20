/**
 * Values that must not be duplicated across packages.
 */

/**
 * PBKDF2 rounds.
 *
 * Workers caps the parameter at 100,000, and the free plan allows 10ms of CPU
 * per request, which in practice covers something in the tens of thousands.
 * OWASP asks for far more than the platform permits, so password strength
 * carries the weight here instead (spec 9.3). Measuring this on a real
 * deployment is an acceptance criterion; local runs do not enforce CPU.
 */
export const PBKDF2_ITERATIONS = 50_000;

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Circuit breaker, not a quota: ten times a realistic day (spec 5.7). */
export const MAX_EVENTS_PER_DAY = 500;

export const MAX_NOTE_LENGTH = 1000;

/** How far ahead a timestamp may be, allowing for clock skew (spec 5.7). */
export const MAX_FUTURE_DAYS = 1;

export const DEFAULT_TIMEZONE = 'Asia/Taipei';
