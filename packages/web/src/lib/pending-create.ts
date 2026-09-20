import type { NewEventInput } from './store.js';

/**
 * The one add whose result is not yet known, kept where a re-render cannot
 * reach it.
 *
 * It has to outlive the component that started it. A request that ends in
 * a 401 signs the app out, which unmounts the form, the store and every
 * piece of state the retry depended on -- including the event id. Sign back
 * in, and a parent repeating what they were doing would write a second copy
 * of a record the server may already hold (spec 6.1).
 *
 * Tied to the user and the baby it was started for, so signing in as
 * somebody else never picks it up. Storage is best effort: iOS clears it
 * without warning (spec 9.6), and a reload that loses it is the same
 * situation as never having had it.
 *
 * One slot, not a queue. The queue belongs to M2, with its own backoff,
 * its own failure states and a screen to work through them.
 */

const KEY = 'dongfan.pending-create';

export type PendingCreate = {
  userId: string;
  babyId: string;
  /** Generated once. Resending under a different one is the duplicate. */
  eventId: string;
  input: NewEventInput;
};

function isPending(value: unknown): value is PendingCreate {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['babyId'] === 'string' &&
    typeof candidate['eventId'] === 'string' &&
    typeof candidate['input'] === 'object' &&
    candidate['input'] !== null &&
    typeof (candidate['input'] as Record<string, unknown>)['typeId'] === 'string'
  );
}

export function readPending(): PendingCreate | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPending(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The pending add for this user and baby, if there is one. */
export function pendingFor(userId: string, babyId: string): PendingCreate | null {
  const pending = readPending();
  if (!pending) return null;
  return pending.userId === userId && pending.babyId === babyId ? pending : null;
}

export function writePending(pending: PendingCreate): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pending));
  } catch {
    // Without storage the retry still works for as long as the screen
    // stays up, which is the common case.
  }
}

export function clearPending(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
