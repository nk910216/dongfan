import { MIN_PASSWORD_LENGTH, PBKDF2_ITERATIONS } from './constants.js';

/**
 * Password hashing and token digests.
 *
 * Lives in the shared package because the CLI that creates accounts and the
 * worker that verifies them must agree exactly. Two implementations of one
 * format eventually disagree, and the symptom is a parent who cannot log in.
 *
 * Runs on the Workers runtime.
 *
 * PBKDF2 through SubtleCrypto: native, fast, and nothing to bundle. bcrypt
 * and argon2 are deliberately heavier algorithms, which is exactly wrong
 * against a 10ms CPU ceiling (spec 9.3).
 *
 * Never move any part of this to the client: the hash would then be the
 * password, and a leaked database would grant login directly.
 */

const SALT_BYTES = 16;
const KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c: string) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Produces `pbkdf2$sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * Verifies against the cost recorded in the stored string, not the current
 * constant, so raising the iteration count later does not lock anyone out.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;

  const iterations = Number(parts[2]);
  const salt = parts[3];
  const expected = parts[4];
  if (!Number.isInteger(iterations) || iterations < 1 || !salt || !expected) return false;

  const actual = await derive(password, fromBase64(salt), iterations);
  return timingSafeEqual(actual, fromBase64(expected));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

const TOKEN_BYTES = 32;

/** 256 bits of entropy, rendered as hex. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Unsalted SHA-256, deliberately.
 *
 * A salted digest cannot be looked up by the value a client presents, which
 * would mean scanning the table on every request. The input is random rather
 * than human-chosen, so there is nothing to pre-compute against (spec 9.2).
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A hash to verify against when no account matched.
 *
 * Skipping the work, or using a cheaper cost, makes an unknown username
 * answer far faster than a wrong password and turns response time into a way
 * to enumerate accounts. The salt and digest are fixed zeroes: they can never
 * match, and their content is irrelevant because only the cost matters here.
 */
export const DUMMY_PASSWORD_HASH =
  `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toBase64(new Uint8Array(SALT_BYTES))}$${toBase64(new Uint8Array(KEY_BITS / 8))}`;

/** Length and nothing else; see MIN_PASSWORD_LENGTH for why. */
export function isPasswordLongEnough(password: string): boolean {
  return [...password].length >= MIN_PASSWORD_LENGTH;
}
