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

/**
 * Minimum password length.
 *
 * The platform caps hashing cost far below what OWASP asks for, so length is
 * what actually protects the database if it ever leaks. Accounts are created
 * by a CLI that generates passwords, which makes this easy to enforce
 * (spec 9.3).
 */
export const MIN_PASSWORD_LENGTH = 20;

/**
 * Maximum password length.
 *
 * An upper bound on work, not on security: every character is hashed, and
 * the worker has ten milliseconds of CPU for the whole request. Enforced
 * identically wherever a password is accepted, because a value one side
 * takes and the other refuses produces an account that cannot log in.
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Timezones the first version supports.
 *
 * Taipei has no daylight saving, which is what makes "at most 24 hours means
 * at most one midnight crossing" true. Somewhere with DST breaks that
 * premise, and the splitting logic and query bounds would both need
 * revisiting (spec 5.3).
 */
export const SUPPORTED_TIMEZONES = ['Asia/Taipei'] as const;
