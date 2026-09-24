/**
 * One-time codes for letting the other parent in.
 *
 * A leaked code is every record of the baby, so there is no such thing as a
 * code that is merely inconvenient to guess: it carries at least 128 bits
 * of randomness, it works once, and it stops working an hour after it was
 * made (spec 6.5).
 *
 * The database holds an unsalted SHA-256 of it, for the same reason
 * sessions do: a salted digest cannot be found by the value somebody types,
 * which would mean reading every row on every attempt. There is nothing to
 * precompute against because the input is random rather than chosen by a
 * person (spec 6.5, 9.2).
 */

/**
 * Crockford's base32: no I, L, O or U.
 *
 * The first three are what somebody reads back wrongly off a screen, and U
 * is left out so that no accident of randomness spells anything. Thirty-two
 * symbols means five bits each, exactly, with no modulo bias to reason
 * about.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Six groups of five: 150 bits, comfortably past the floor spec 6.5 sets. */
const LENGTH = 30;
const GROUP = 5;

/** An hour, and not a minute of it configurable (spec 6.5). */
export const INVITE_CODE_TTL_MS = 60 * 60 * 1000;

/**
 * A new code, in the form it is shown in.
 *
 * One random byte per symbol, masked to five bits. 256 is a whole number of
 * 32s, so every symbol is equally likely; taking a remainder of a larger
 * range would quietly favour the start of the alphabet.
 */
export function generateInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  const symbols = [...bytes].map((byte) => ALPHABET[byte & 31] ?? '0');

  const groups: string[] = [];
  for (let at = 0; at < symbols.length; at += GROUP) {
    groups.push(symbols.slice(at, at + GROUP).join(''));
  }
  return groups.join('-');
}

/**
 * What somebody typed, as the thing that was generated.
 *
 * Case, spacing and the dashes are presentation and are thrown away. The
 * three symbols the alphabet leaves out are the ones people substitute
 * without noticing, so they are read as what was meant rather than refused:
 * an invitation that fails because a capital O was typed for a zero is a
 * support call at three in the morning.
 */
export function normaliseInviteCode(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-Z]/g, '');
}

/** Whether a normalised code could be one of ours at all. */
export function isInviteCodeShaped(normalised: string): boolean {
  if (normalised.length !== LENGTH) return false;
  return [...normalised].every((symbol) => ALPHABET.includes(symbol));
}
