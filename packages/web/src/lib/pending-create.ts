import type { NewEventInput } from './store.js';

/**
 * The adds whose result is not yet known, kept where a re-render cannot
 * reach them.
 *
 * One of these has to outlive the component that started it. A request
 * ending in a 401 signs the app out, which unmounts the form, the store and
 * every piece of state the retry depended on -- including the event id.
 * Sign back in, and a parent repeating what they were doing would write a
 * second copy of a record the server may already hold (spec 6.1).
 *
 * A list rather than one slot, and every read and write named by its event
 * id. With a single slot, recording a nappy while a bottle was still in
 * doubt either overwrote the bottle or, on success, deleted it: both lose
 * the id that was the whole point. Nothing here touches an entry that is
 * not its own.
 *
 * This is still not the offline queue. There is no schedule, no backoff, no
 * automatic retry and no failure state: an entry sits here until a parent
 * opens that type's form again and presses send, and the only thing it
 * buys is that pressing send reaches the same row. The queue belongs to M2.
 *
 * Storage is best effort: iOS clears it without warning (spec 9.6), and a
 * reload that loses it is the same situation as never having had it.
 */

const KEY = 'dongfan.pending-creates';

/**
 * More unresolved adds than this means something is badly wrong -- the one
 * runaway case the write guardrails exist for (spec 5.7). The oldest is
 * dropped rather than refusing to record, because refusing would lose the
 * record a parent is making right now.
 */
const MAX_PENDING = 10;

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
  const input = candidate['input'];
  return (
    typeof candidate['userId'] === 'string' &&
    typeof candidate['babyId'] === 'string' &&
    typeof candidate['eventId'] === 'string' &&
    typeof input === 'object' &&
    input !== null &&
    typeof (input as Record<string, unknown>)['typeId'] === 'string'
  );
}

function readAll(): PendingCreate[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: PendingCreate[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX_PENDING)));
  } catch {
    // Without storage the retry still works for as long as the screen
    // stays up, which is the common case.
  }
}

/** Everything unresolved for this user and this baby, oldest first. */
export function pendingList(userId: string, babyId: string): PendingCreate[] {
  return readAll().filter((entry) => entry.userId === userId && entry.babyId === babyId);
}

/**
 * The oldest unresolved add of one type.
 *
 * Narrowed to the type as well as the user and the baby: a nappy shortcut
 * resending somebody's bottle would be worse than the duplicate all of this
 * exists to prevent.
 */
export function pendingFor(userId: string, babyId: string, typeId: string): PendingCreate | null {
  return pendingList(userId, babyId).find((entry) => entry.input.typeId === typeId) ?? null;
}

/** Adds or replaces one entry, leaving every other entry alone. */
export function rememberPending(pending: PendingCreate): void {
  const others = readAll().filter((entry) => entry.eventId !== pending.eventId);
  writeAll([...others, pending]);
}

/**
 * Removes one entry, named by all three of its keys.
 *
 * An add that succeeds says nothing about any other add. Clearing the whole
 * store on success threw away a bottle still waiting to be confirmed,
 * including one belonging to a different account.
 */
export function forgetPending(userId: string, babyId: string, eventId: string): void {
  const before = readAll();
  const after = before.filter(
    (entry) => !(entry.userId === userId && entry.babyId === babyId && entry.eventId === eventId),
  );
  if (after.length !== before.length) writeAll(after);
}
