/**
 * The API returns codes, never sentences (spec 5.2).
 *
 * Text for a user to read is resolved in the web layer through i18n, which
 * keeps the backend out of the presentation layer and keeps every Chinese
 * string in one file.
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'ID_CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'DAILY_LIMIT_EXCEEDED',
  'ACTIVE_TIMER_EXISTS',
  'TAG_NAME_TAKEN',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const FIELD_ERROR_CODES = [
  'REQUIRED',
  'OUT_OF_RANGE',
  'TOO_LONG',
  'NOT_INTEGER',
  'INVALID_ENUM',
  'UNKNOWN_FIELD',
  'INVALID_FORMAT',
  'END_BEFORE_START',
  'DURATION_TOO_LONG',
  'TOO_FAR_IN_FUTURE',
  'BEFORE_BIRTH',
] as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/** Values the copy interpolates. Always present, `{}` when there are none. */
export type ErrorParams = Readonly<Record<string, string | number>>;

export type FieldError = {
  /** Path into the request body; nested fields use dots, `metadata.side`. */
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly params: ErrorParams;
};

export type ApiError = {
  readonly code: ErrorCode;
  readonly details?: { readonly fields: readonly FieldError[] } | Readonly<Record<string, unknown>> | null;
};

export type ApiErrorResponse = { readonly error: ApiError };

const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES);
const KNOWN_FIELD_ERROR_CODES = new Set<string>(FIELD_ERROR_CODES);

export function isKnownErrorCode(code: string): code is ErrorCode {
  return KNOWN_ERROR_CODES.has(code);
}

export function isKnownFieldErrorCode(code: string): code is FieldErrorCode {
  return KNOWN_FIELD_ERROR_CODES.has(code);
}
