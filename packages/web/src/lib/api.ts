import { isKnownErrorCode } from '@dongfan/shared';
import type { ErrorCode, FieldError } from '@dongfan/shared';

/**
 * The one place a request leaves the app.
 *
 * Errors arrive as codes and are carried as codes: turning one into a
 * sentence here would spread interface copy across the whole client, and
 * the copy file is meant to be the only place it lives (spec 5.2, 13.1).
 */

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly fields: FieldError[];

  constructor(status: number, code: string, fields: FieldError[] = []) {
    super(`API ${status} ${code}`);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  /** True for codes this build was written against. */
  get isKnown(): boolean {
    return isKnownErrorCode(this.code);
  }
}

/** Thrown when the request never reached the server. */
export class NetworkFailure extends Error {
  constructor(cause: unknown) {
    super('Request did not reach the server');
    this.name = 'NetworkFailure';
    this.cause = cause;
  }
}

/**
 * Thrown by the client before anything is sent, because it knows there is
 * no connection.
 *
 * Distinct from `NetworkFailure` on purpose. That one means "we do not
 * know whether the server got it"; this one means "nothing left the
 * device", which is a fact and not a doubt. Conflating them would put an
 * event into the queue marked as possibly stored when it certainly is not,
 * and a parent would then be barred from correcting it (spec 6.1).
 */
export class OfflineError extends Error {
  constructor() {
    super('The device is offline');
    this.name = 'OfflineError';
  }
}

/**
 * Whether the device says it has no connection at all.
 *
 * Only trusted in one direction. `false` means no interface is up, so
 * nothing can have been sent; `true` means very little, which is why a
 * request is still attempted and still has to cope with failing.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

type ErrorBody = {
  error?: { code?: unknown; details?: { fields?: unknown } | null };
};

function toFailure(status: number, body: unknown): ApiFailure {
  const error = (body as ErrorBody | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  const raw = error?.details?.fields;
  const fields = Array.isArray(raw) ? (raw as FieldError[]) : [];

  // A published app outlives the build it was tested against, so meeting a
  // code this bundle has never heard of is a matter of when (spec 5.2).
  if (!isKnownErrorCode(code)) console.warn(`Unrecognised error code from API: ${code}`);

  return new ApiFailure(status, code, fields);
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | undefined;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // Kept distinct from a refusal by the server. "We do not know whether
    // this landed" and "the server said no" call for different handling,
    // and conflating them is what loses a record (spec 6.1).
    throw new NetworkFailure(cause);
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toFailure(response.status, body);
  return body as T;
}
