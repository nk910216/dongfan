import type { EventDto } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from './api.js';
import {
  applyOne, beginSend, correctQueuedEntry, enqueue, getQueued, listQueued, putQueued, queueIfAbsent,
  removeQueued, requeue, scopeOf,
} from './db.js';
import type { NewEventInput, QueuedCreate, Scope } from './db.js';
import { outcomeIsUnknown, provesNotStored } from './outcome.js';

/**
 * The queue of adds waiting to reach the server.
 *
 * Creations only. An edit made offline carries the version that was read
 * offline, so it comes back 409 nearly every time, and the answer to a 409
 * is to ask the person -- at three in the morning, with five of them
 * stacked up. Refusing to edit offline keeps the thing that matters (write
 * down the feed you just gave) and drops the part that cannot be made to
 * work (spec 6.1).
 *
 * Two things here are easy to get wrong and impossible to notice:
 *
 * The id is generated once, by the screen, and never again. It is the
 * server's idempotency key, and a resend under a fresh one produces the
 * second copy the whole mechanism exists to prevent (spec 3.8, 5.8).
 *
 * And a lost response is not a refusal. If the add did land, sending
 * corrected content under the same id returns the *stored* event, so the
 * correction vanishes silently. That is what `outcomeUnknown` is for, and
 * why it is sticky: a 401 arriving on the retry says the session expired,
 * not that the first attempt failed to store anything (spec 6.1).
 */

/** The shortest wait between attempts (spec 6.1). */
export const FIRST_DELAY_MS = 5_000;

/** And the longest. Doubling stops here rather than growing. */
export const MAX_DELAY_MS = 300_000;

/**
 * How many attempts an entry gets before it stops and waits for a person.
 *
 * Counted attempts only: a 401 and a 429 are the queue being told to wait,
 * not the entry being refused, and neither spends one of these. Nothing
 * retries for ever -- an entry that has spent them is marked `failed` and
 * shown in the list, with its content intact (spec 6.1).
 */
export const MAX_ATTEMPTS = 10;

/**
 * The wait before attempt number `attempt`.
 *
 * Doubling from five seconds, capped at five minutes. Attempt one has
 * already happened by the time this is asked, so the first wait is the one
 * before attempt two.
 */
export function delayFor(attempt: number): number {
  const doubled = FIRST_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(doubled, MAX_DELAY_MS);
}

/**
 * What an answer means for the queue, as opposed to what it means for the
 * entry's content.
 *
 * Deliberately not "4xx means give up". A session that expired and a body
 * the server will never accept are both 4xx and call for opposite
 * handling, and treating them alike either throws away a record a parent
 * wrote or retries something that can never succeed (spec 6.1).
 */
export type Disposition =
  /** Network or 5xx: try again later, and it counts. */
  | 'retry'
  /** 401: the whole queue stops until the same person signs in again. */
  | 'pause'
  /** 429: try again later, and it does not count. */
  | 'wait'
  /** Anything the server said definitely: stop, keep the record, show it. */
  | 'giveUp';

export function disposition(error: unknown): Disposition {
  if (error instanceof NetworkFailure) return 'retry';
  if (!(error instanceof ApiFailure)) return 'retry';
  if (error.status >= 500) return 'retry';
  if (error.status === 401) return 'pause';
  if (error.status === 429) return 'wait';
  return 'giveUp';
}

/**
 * The entry as it stands after one attempt came back badly.
 *
 * A pure function, because every rule that matters is in here and each of
 * them is a sentence from spec 6.1 that fails quietly when broken.
 */
export function afterFailure(entry: QueuedCreate, error: unknown, now: number): QueuedCreate {
  // Every attempt the queue makes sends the entry's own stored content
  // under its own id, so each one is the "resend the original" that the
  // rules are written for.
  //
  // Doubt, once present, is only ever removed by a refusal the server
  // could not have produced for an event it had stored. A later 401, 429,
  // 403 or 404 says nothing about whether the first attempt landed.
  const outcomeUnknown = entry.outcomeUnknown
    ? !provesNotStored(error)
    : outcomeIsUnknown(error);

  const lastCode = error instanceof ApiFailure ? error.code : null;
  const base = { ...entry, outcomeUnknown, lastCode };

  switch (disposition(error)) {
    case 'retry': {
      const attempts = entry.attempts + 1;
      return attempts >= MAX_ATTEMPTS
        ? { ...base, attempts, state: 'failed' }
        : { ...base, attempts, nextAttemptAt: now + delayFor(attempts) };
    }
    case 'wait':
      // Being asked to slow down is not the entry's fault, so it keeps its
      // attempts. It still has to wait, or the queue would spin against a
      // rate limit it is causing.
      return { ...base, nextAttemptAt: now + delayFor(entry.attempts + 1) };
    case 'pause':
      // Left exactly as it was. The queue stops as a whole; this entry has
      // not been refused and must not be aged towards `failed` by a
      // session that happened to expire underneath it.
      return { ...entry, outcomeUnknown, lastCode };
    case 'giveUp':
      return { ...base, state: 'failed' };
  }
}

/**
 * Thrown when an entry a screen was working on is no longer in the queue.
 *
 * Almost always because the queue sent it in the background while the
 * screen was open. It matters most for a correction: the server now holds
 * the *original*, so posting the amended version under the same id would
 * come back as the stored one and the correction would be lost. The way to
 * change it from here is an edit, with a version (spec 6.1, 6.3).
 */
export class EntryGone extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`No queued entry for ${eventId}`);
    this.name = 'EntryGone';
    this.eventId = eventId;
  }
}

/** Sends one add. Supplied by the caller so this file never touches fetch. */
export type Send = (eventId: string, input: NewEventInput) => Promise<EventDto>;

export type Attempt =
  | { ok: true; event: EventDto }
  | { ok: false; error: unknown; entry: QueuedCreate };

/**
 * One attempt at one entry.
 *
 * The entry is put in doubt *before* the request leaves, not after it
 * comes back badly. Everything between the two is a window in which the
 * server may already hold the event while this device believes it does
 * not, and a correction made or allowed in that window is lost in
 * silence (spec 6.1). A browser closed mid-request lands in the same
 * window, and the doubt is what is still there when it reopens.
 *
 * What is sent is what that transaction read back, not the copy the
 * caller was holding, which may have been corrected since.
 *
 * On success the event is stored before the entry is removed. Crashing
 * between the two leaves an entry that will be sent again, get the stored
 * event back from the server's idempotency check and be removed then --
 * whereas removing first and crashing would lose the record entirely.
 */
export async function attemptQueued(
  scope: Scope,
  entry: QueuedCreate,
  send: Send,
  now: number = Date.now(),
): Promise<Attempt> {
  const sending = await beginSend(scope, entry.eventId);
  // Abandoned before this got started. Nothing is put back.
  if (!sending) return { ok: false, error: new EntryGone(entry.eventId), entry };

  try {
    const event = await send(sending.eventId, sending.input);
    await applyOne(scope, event);
    await removeQueued(scope, sending.eventId);
    return { ok: true, event };
  } catch (error) {
    // Read back rather than written from the copy in hand: a correction or
    // a manual retry may have touched this row while the request was in
    // the air, and writing a stale copy over it would undo that. Gone
    // means abandoned while it was in flight, and nothing is put back.
    const current = await getQueued(scope, entry.eventId);
    if (!current) return { ok: false, error, entry };

    const updated = afterFailure(current, error, now);
    await putQueued(updated);
    return { ok: false, error, entry: updated };
  }
}

export type RunResult = {
  /** How many reached the server. */
  sent: number;
  /** True when a 401 stopped the run. Nothing else stops it early. */
  paused: boolean;
  /** When the next entry becomes due, or null when nothing is waiting. */
  nextDueAt: number | null;
};

/**
 * Sends everything that is due, oldest first.
 *
 * One at a time. Firing them in parallel would start several timers of the
 * same type at once, and the second would come back
 * `ACTIVE_TIMER_EXISTS` -- a refusal caused entirely by how they were
 * sent (spec 3.5).
 *
 * A 401 stops the whole run rather than just the entry: the token is dead,
 * so every remaining attempt would spend a request to be told the same
 * thing. The entries stay, and the next run happens after the same person
 * signs in again (spec 6.1).
 */
export async function runOutbox(scope: Scope, send: Send, now = (): number => Date.now()): Promise<RunResult> {
  let sent = 0;

  for (const queued of await listQueued(scope)) {
    // Read again rather than trusting the list. Ten entries on a slow
    // connection is half a minute, and in that time somebody can have
    // given up on one of them or corrected it from the list. Sending what
    // the snapshot said would undo either.
    const entry = await getQueued(scope, queued.eventId);
    if (!entry) continue;
    if (entry.state !== 'queued') continue;
    if (entry.nextAttemptAt > now()) continue;

    const result = await attemptQueued(scope, entry, send, now());
    if (result.ok) {
      sent += 1;
      continue;
    }
    if (disposition(result.error) === 'pause') {
      return { sent, paused: true, nextDueAt: await nextDueAt(scope, now()) };
    }
  }

  return { sent, paused: false, nextDueAt: await nextDueAt(scope, now()) };
}

/**
 * When the earliest waiting entry becomes due.
 *
 * Null when there is nothing to wait for, which is what stops the caller
 * arming a timer that would wake the app up for no reason.
 */
export async function nextDueAt(scope: Scope, now: number): Promise<number | null> {
  const due = (await listQueued(scope))
    .filter((entry) => entry.state === 'queued')
    .map((entry) => Math.max(entry.nextAttemptAt, now));
  return due.length === 0 ? null : Math.min(...due);
}

/**
 * Puts an add into the queue before any attempt is made to send it.
 *
 * Written down first, always, even when the connection looks fine. The
 * gap between a parent pressing save and the request failing is where a
 * record used to be lost: a 401 unmounts the screen holding it, and a
 * browser killed in that window takes it with it.
 */
export async function queueAdd(
  userId: string,
  babyId: string,
  eventId: string,
  input: NewEventInput,
  now: number = Date.now(),
): Promise<QueuedCreate> {
  return enqueue({ scope: scopeOf(userId, babyId), userId, babyId, eventId, input }, now);
}

/**
 * Replaces the content of a waiting entry.
 *
 * Refused while the outcome is unknown. The server may already hold this
 * id, in which case a corrected POST comes back as the event it already
 * has and the correction is lost without a trace; the way forward is to
 * resend the original first and find out (spec 6.1).
 *
 * The check and the write are one transaction, in `correctQueuedEntry`,
 * because a send starting between them would take the original to the
 * server while this wrote the correction over it. That is reachable: the
 * queue sends on its own schedule, and the screen offering this button has
 * no way to know one has just begun.
 *
 * Pressing the button when the entry is already in doubt is not reachable
 * -- the list hides it -- so this throws rather than returning: a caller
 * that gets here has a bug, not a situation.
 */
export async function correctQueued(
  scope: Scope,
  eventId: string,
  input: NewEventInput,
  now: number = Date.now(),
): Promise<QueuedCreate> {
  const result = await correctQueuedEntry(scope, eventId, input, now);
  if (result.ok) return result.entry;
  if (result.reason === 'gone') throw new EntryGone(eventId);
  throw new Error('Cannot correct an entry whose outcome is unknown');
}

/**
 * Puts a stopped entry back in the queue, unchanged.
 *
 * The counters start again because a person asked for this, which is a
 * different thing from the queue deciding to try once more.
 */
export async function retryQueued(
  scope: Scope,
  eventId: string,
  now: number = Date.now(),
): Promise<QueuedCreate> {
  const entry = await requeue(scope, eventId, now);
  if (!entry) throw new EntryGone(eventId);
  return entry;
}

/**
 * Stops trying, and forgets the entry.
 *
 * This says nothing about the server. If the outcome was unknown the event
 * may well be stored, and the copy shown to the parent has to say so
 * rather than the word "deleted" (spec 6.1).
 */
export async function abandonQueued(scope: Scope, eventId: string): Promise<void> {
  await removeQueued(scope, eventId);
}

/**
 * The store this queue replaces.
 *
 * Before there was a queue, an add whose response was lost was written to
 * `localStorage` so that the screen could offer to resend it. Somebody's
 * phone may be holding one right now, and it is a record a parent typed at
 * three in the morning that the server may or may not have.
 */
const LEGACY_KEY = 'dongfan.pending-creates';

type LegacyPending = {
  userId: string;
  babyId: string;
  eventId: string;
  input: NewEventInput;
};

function isLegacy(value: unknown): value is LegacyPending {
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

function readLegacy(): LegacyPending[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isLegacy) : [];
  } catch {
    return [];
  }
}

function writeLegacy(entries: LegacyPending[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(LEGACY_KEY);
    else localStorage.setItem(LEGACY_KEY, JSON.stringify(entries));
  } catch {
    // Nothing more can be done about it, and the entries are already in
    // the queue by this point. The worst case is doing this again next
    // time, which `queueIfAbsent` makes harmless.
  }
}

/**
 * Moves what the old store was holding into the queue.
 *
 * Three things must hold, and each of them has failed in this codebase
 * before:
 *
 * *Nothing is lost.* Every entry moves, including ones belonging to an
 * account that is not signed in now -- the scope comes from the entry
 * itself, never from the current session, which is also what keeps one
 * family's records out of another's.
 *
 * *Nothing is sent twice.* The event id travels unchanged, so the server's
 * idempotency check recognises an add that already landed.
 *
 * *Nothing is retried under the wrong assumption.* An entry only ever
 * existed because an attempt ended in silence, so every one of them
 * arrives in doubt. The queue will resend the original content under the
 * original id, which is exactly how that doubt is meant to be settled.
 *
 * One entry at a time, removed from the old store only once it is in the
 * new one. Interrupted halfway, the rest are still there for next time.
 */
export async function migrateLegacyPending(now: number = Date.now()): Promise<number> {
  const entries = readLegacy();
  if (entries.length === 0) return 0;

  let moved = 0;
  let remaining = entries;

  for (const entry of entries) {
    await queueIfAbsent({
      scope: scopeOf(entry.userId, entry.babyId),
      userId: entry.userId,
      babyId: entry.babyId,
      eventId: entry.eventId,
      input: entry.input,
      outcomeUnknown: true,
      attempts: 0,
      // Due immediately: settling the doubt is the most useful thing the
      // queue can do, and it is the oldest thing in it.
      nextAttemptAt: 0,
      state: 'queued',
      lastCode: null,
      queuedAt: now,
    });
    moved += 1;
    remaining = remaining.filter((other) => other.eventId !== entry.eventId);
    writeLegacy(remaining);
  }

  return moved;
}

/**
 * Runs the migration once per load, whoever asks first.
 *
 * Every mount would otherwise start its own, and two running together
 * would both read the same old store and race each other's removals.
 */
let migration: Promise<number> | null = null;

export function ensureMigrated(): Promise<number> {
  migration ??= migrateLegacyPending();
  return migration;
}

/** For tests, so one file's migration cannot satisfy the next one's. */
export function resetMigration(): void {
  migration = null;
}
