import type { Context } from 'hono';
import type { ErrorCode, FieldError } from '@dongfan/shared';

/**
 * Error responses carry a code, never a sentence.
 *
 * Wording belongs to the web layer, which resolves the code through the copy
 * file. That keeps every Chinese string in one place and keeps the backend
 * out of presentation entirely (spec 5.2).
 */

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ACTIVE_TIMER_EXISTS: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  DAILY_LIMIT_EXCEEDED: 429,
  INTERNAL: 500,
};

export function fail(c: Context, code: ErrorCode, details?: unknown): Response {
  return c.json({ error: { code, details: details ?? null } }, STATUS[code] as 400);
}

export function failValidation(c: Context, fields: FieldError[]): Response {
  return fail(c, 'VALIDATION_FAILED', { fields });
}

/**
 * The parts of a validation issue this translation reads.
 *
 * Declared structurally rather than importing Zod's own types: those carry
 * optional properties that clash with exactOptionalPropertyTypes, and this
 * mapping only ever needs these fields.
 */
type IssueLike = {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly type?: string;
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly received?: unknown;
  readonly options?: readonly unknown[];
};

/** Translates validation issues into the field errors of spec 5.2.1. */
export function zodToFieldErrors(issues: readonly IssueLike[]): FieldError[] {
  return issues.map((issue): FieldError => {
    const field = issue.path.join('.');

    switch (issue.code) {
      case 'invalid_type':
        return issue.received === 'undefined'
          ? { field, code: 'REQUIRED', params: {} }
          : { field, code: 'INVALID_FORMAT', params: {} };
      case 'too_small':
        // A minimum of one on a string means the field was left empty,
        // which reads better as "required" than as a range problem.
        return issue.type === 'string' && Number(issue.minimum) <= 1
          ? { field, code: 'REQUIRED', params: {} }
          : { field, code: 'OUT_OF_RANGE', params: { min: Number(issue.minimum) } };
      case 'too_big':
        return issue.type === 'string'
          ? { field, code: 'TOO_LONG', params: { maxLength: Number(issue.maximum) } }
          : { field, code: 'OUT_OF_RANGE', params: { max: Number(issue.maximum) } };
      case 'invalid_enum_value':
        return { field, code: 'INVALID_ENUM', params: { allowed: (issue.options ?? []).map(String).join(',') } };
      case 'not_finite':
        return { field, code: 'NOT_INTEGER', params: {} };
      default:
        return { field, code: 'INVALID_FORMAT', params: {} };
    }
  });
}
