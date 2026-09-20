/**
 * Client-generated identifiers, which double as idempotency keys.
 *
 * An id made here and reused is what lets a second press after a failed
 * save reach the same record instead of making another one (spec 3.8, 5.8).
 * Generating a fresh one on retry is the bug this exists to prevent.
 */

export function newClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  // randomUUID needs a secure context, which a phone on a LAN address over
  // plain HTTP is not. Without the fallback, adding anything from a phone
  // during testing would throw rather than degrade (spec 10.1).
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
