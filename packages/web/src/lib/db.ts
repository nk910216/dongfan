import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { EventDto, EventIntent, SummaryDto } from '@dongfan/shared';

/**
 * The only thing on this device that persists.
 *
 * Events, the sync cursor and the queue of writes waiting to be sent all
 * live here. The query cache above it is a view and may be thrown away at
 * any moment; this is what survives a reload, and it is what "the app
 * works on a train" means (spec 6.2).
 *
 * Everything is scoped to one account and one baby. Not as a tidiness
 * measure: without it, switching accounts shows the previous one's records,
 * and a queued write could be sent by the wrong person (spec 6.1, 6.2).
 *
 * iOS clears script-writable storage for a site unused for seven days
 * unless it has been added to the home screen (spec 9.6). Nothing stored
 * here may be treated as reliable, which is why the count of unsent records
 * has to be on screen rather than implied.
 */

const DB_NAME = 'dongfan';
const DB_VERSION = 2;

/**
 * One account, one baby.
 *
 * Joined with a NUL, which cannot appear in either id, so no pair of scopes
 * can be confused for another by concatenation.
 */
export type Scope = string;

export function scopeOf(userId: string, babyId: string): Scope {
  return `${userId}\u0000${babyId}`;
}

/**
 * An event as it is held locally.
 *
 * The event is kept whole under `event` rather than spread across the row,
 * and the three fields beside it exist only because IndexedDB indexes have
 * to be top level. Spreading it would mean stripping the storage keys back
 * off on every read, and a read that forgot would hand the rest of the app
 * a shape the API never produced.
 */
export type StoredEvent = {
  scope: Scope;
  id: string;
  rev: number;
  localDate: string;
  event: EventDto;
};

/** The one place the index keys are derived, so they cannot drift. */
function toRow(scope: Scope, event: EventDto): StoredEvent {
  return { scope, id: event.id, rev: event.rev, localDate: event.localDate, event };
}

/**
 * What a parent filled in, before the server has seen it.
 *
 * Defined here rather than beside the screens because it is a stored
 * shape: a queued add outlives the form that produced it, the process
 * that was running at the time, and in the worst case the build. Anything
 * added to it has to be optional or defaulted on read, for the same
 * reason `withDefaults` exists below.
 */
export type NewEventInput = {
  typeId: string;
  intent: EventIntent;
  startedAt: number;
  endedAt: number | null;
  value?: number | undefined;
  note: string;
  metadata: Record<string, string>;
};

/**
 * `queued` is waiting its turn; `failed` has stopped by itself and needs a
 * person. Nothing is ever thrown away by either (spec 6.1).
 */
export type QueuedState = 'queued' | 'failed';

/**
 * One add waiting to reach the server.
 *
 * The queue takes creations only. An offline `PATCH` carries the version
 * read while offline and comes back 409 almost every time, and a 409 is
 * answered by asking the person -- who is asleep (spec 6.1). Editing and
 * deleting are refused outright instead.
 */
export type QueuedCreate = {
  scope: Scope;
  /**
   * Repeated from the scope rather than parsed back out of it.
   *
   * A row has to be able to say whose it is on its own, because the
   * migration from the old store writes rows for accounts that are not
   * the one signed in now, and reading them back means knowing which
   * account each belongs to without splitting a string.
   */
  userId: string;
  babyId: string;
  /**
   * Generated once, by the screen, and never regenerated. It is the
   * server's idempotency key: a resend under a new id is the duplicate
   * the whole queue exists to prevent (spec 3.8, 5.8).
   */
  eventId: string;
  /** Exactly what was, or will be, sent. */
  input: NewEventInput;
  /**
   * Sticky. Set when an attempt ended with nothing from the server, and
   * cleared only by a refusal the server could not have given for a
   * stored event (spec 6.1).
   *
   * While it is true the content may not be corrected: sending amended
   * content under an id the server may already hold returns the *stored*
   * event, and the correction disappears with nothing on screen to say
   * so.
   */
  outcomeUnknown: boolean;
  /** Attempts that count towards the cap. A 401 or a 429 is not one. */
  attempts: number;
  /** Epoch ms; the queue will not touch this entry before it. */
  nextAttemptAt: number;
  state: QueuedState;
  /** The last code the server answered with, for the list of failures. */
  lastCode: string | null;
  /** When it first joined the queue. Orders the queue, oldest first. */
  queuedAt: number;
};

export type SyncMeta = {
  scope: Scope;
  /**
   * The rev the server last issued us. Sent back as `since`, never derived
   * from a clock (spec 5.4).
   */
  cursor: number;
  /** When the last successful pull finished, for the staleness indicator. */
  syncedAt: number | null;
  /**
   * The last summary the server calculated.
   *
   * Cached rather than recomputed: summaries are derived data and belong to
   * the server, because the range that changes when an event moves is not
   * something a client can work out (spec 6.2). Offline, the last one is
   * shown and marked as such (spec 5.5).
   */
  summary: SummaryDto | null;
  summaryAt: number | null;
  /**
   * The cursor the sync had reached when that summary was fetched.
   *
   * A summary carries no version of its own, so this is what orders two of
   * them. Without it a slow request can write its older view over a newer
   * one, and the figures on the home screen go backwards while the header
   * says the sync just succeeded.
   */
  summaryCursor: number;
};

interface DongfanDb extends DBSchema {
  events: {
    key: [Scope, string];
    value: StoredEvent;
    indexes: {
      'by-scope-rev': [Scope, number];
      'by-scope-date': [Scope, string];
    };
  };
  meta: {
    key: Scope;
    value: SyncMeta;
  };
  outbox: {
    key: [Scope, string];
    value: QueuedCreate;
    indexes: {
      'by-scope': Scope;
    };
  };
}

let handle: Promise<IDBPDatabase<DongfanDb>> | null = null;

export function db(): Promise<IDBPDatabase<DongfanDb>> {
  handle ??= openDB<DongfanDb>(DB_NAME, DB_VERSION, {
    // Each store is created only if it is missing, rather than switching on
    // the version it is coming from. A phone that has had every build sees
    // the same thing as one installing today, and a store added in a later
    // version cannot be skipped by a device that jumped two versions at
    // once.
    upgrade(database) {
      if (!database.objectStoreNames.contains('events')) {
        const events = database.createObjectStore('events', { keyPath: ['scope', 'id'] });
        // Ordered by rev, which is how a page of the sync feed arrives and
        // the only ordering the server guarantees is a write order.
        events.createIndex('by-scope-rev', ['scope', 'rev']);
        // The home screen and the calendar both ask for one local day.
        events.createIndex('by-scope-date', ['scope', 'localDate']);
      }

      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'scope' });
      }

      if (!database.objectStoreNames.contains('outbox')) {
        const outbox = database.createObjectStore('outbox', { keyPath: ['scope', 'eventId'] });
        // Everything the queue does is per account and baby: what it sends,
        // what it counts and what it shows (spec 6.1).
        outbox.createIndex('by-scope', 'scope');
      }
    },
  });

  return handle;
}

/** Drops the cached handle, so the next call reopens. For tests. */
export function closeDb(): void {
  void handle?.then((database) => database.close());
  handle = null;
}

const EMPTY_META = (scope: Scope): SyncMeta => ({
  scope,
  // Zero means "everything", which is what a first sync asks for.
  cursor: 0,
  syncedAt: null,
  summary: null,
  summaryAt: null,
  // Below any real cursor, so the first summary of any kind wins.
  summaryCursor: -1,
});

/**
 * Fills in whatever a stored record does not have.
 *
 * A row written by an older build is missing the fields added since, and
 * comparing a number against `undefined` is false rather than an error:
 * `summaryCursor` arrived in this shape, and without this the summary on a
 * phone that had already used the app could never be replaced again. The
 * screen would look right until a reload, then show figures from whenever
 * the upgrade happened.
 *
 * Done on every read rather than as a one-off upgrade. A migration that
 * has to succeed exactly once, on a device that may be in a tunnel with a
 * browser that may kill it halfway, is a worse bet than a default applied
 * every time -- and this also covers a record written by a build newer
 * than this one, after a downgrade.
 */
function withDefaults(stored: Partial<SyncMeta> | undefined, scope: Scope): SyncMeta {
  const empty = EMPTY_META(scope);
  if (!stored) return empty;

  return {
    scope,
    cursor: stored.cursor ?? empty.cursor,
    syncedAt: stored.syncedAt ?? empty.syncedAt,
    summary: stored.summary ?? empty.summary,
    summaryAt: stored.summaryAt ?? empty.summaryAt,
    summaryCursor: stored.summaryCursor ?? empty.summaryCursor,
  };
}

export async function readMeta(scope: Scope): Promise<SyncMeta> {
  return withDefaults(await (await db()).get('meta', scope), scope);
}

/**
 * Keeps a summary, unless a newer one is already here.
 *
 * `atCursor` is how far the sync had got when this was fetched, which is
 * the only ordering a summary has. Equal counts as newer: two pulls that
 * found nothing new still describe different moments, since "today" moves
 * on its own.
 */
export async function writeSummary(
  scope: Scope,
  summary: SummaryDto,
  atCursor: number,
): Promise<SummaryDto> {
  const database = await db();
  const tx = database.transaction('meta', 'readwrite');
  const meta = withDefaults(await tx.store.get(scope), scope);

  const winner = atCursor >= meta.summaryCursor ? summary : meta.summary;
  if (winner === summary) {
    await tx.store.put({ ...meta, summary, summaryAt: Date.now(), summaryCursor: atCursor });
  }

  await tx.done;
  // What is stored, not what was fetched. A caller that showed the one it
  // asked for would put the refused summary on screen, and the database
  // being right would not help anybody looking at it.
  return winner ?? summary;
}

/**
 * Applies one page of the sync feed.
 *
 * The events and the cursor are written in a single transaction. Apart,
 * the cursor can move without the rows landing, and everything between the
 * old cursor and the new one is then never asked for again (spec 6.2).
 *
 * Returns how many rows were actually taken, which is not the page size:
 * a row the local copy already has at an equal or higher rev is ignored,
 * because a slow response from an earlier request must not overwrite the
 * result of a later one.
 */
export async function applyPage(
  scope: Scope,
  events: readonly EventDto[],
  cursor: number,
): Promise<number> {
  const database = await db();
  const tx = database.transaction(['events', 'meta'], 'readwrite');
  const store = tx.objectStore('events');
  let applied = 0;

  for (const event of events) {
    const existing = await store.get([scope, event.id]);
    // Only ever forwards. A tombstone is stored like anything else: the row
    // stays, with its rev, so a late reply carrying the pre-deletion
    // version cannot bring it back (spec 6.2).
    if (existing && existing.rev >= event.rev) continue;
    await store.put(toRow(scope, event));
    applied += 1;
  }

  const metaStore = tx.objectStore('meta');
  const meta = withDefaults(await metaStore.get(scope), scope);
  // Never backwards. A page from a request that set out earlier and
  // answered later ends at a lower rev, and moving the cursor back to it
  // would re-ask for everything in between on every sync from then on.
  //
  // Restoring an older backup does move the server's revs back, and that
  // is handled by resetting the client deliberately rather than by letting
  // a cursor drift down (spec 12.2).
  await metaStore.put({ ...meta, cursor: Math.max(meta.cursor, cursor), syncedAt: Date.now() });

  await tx.done;
  return applied;
}

/**
 * Stores one event that came back from a write, and nothing else.
 *
 * Deliberately not `applyPage`: a single write must never move the sync
 * cursor. The event it returns carries the rev the server just allocated,
 * which is higher than anything we have pulled -- setting the cursor to it
 * would declare everything in between already seen, and the rest of that
 * gap would never be asked for again (spec 5.4).
 *
 * The same forwards-only rule applies, so a slow reply cannot overwrite a
 * later one.
 */
export async function applyOne(scope: Scope, event: EventDto): Promise<void> {
  const database = await db();
  const tx = database.transaction('events', 'readwrite');
  const existing = await tx.store.get([scope, event.id]);
  if (!existing || existing.rev < event.rev) await tx.store.put(toRow(scope, event));
  await tx.done;
}

export async function findEvent(scope: Scope, id: string): Promise<EventDto | null> {
  const found = await (await db()).get('events', [scope, id]);
  if (!found || found.event.deletedAt !== null) return null;
  return found.event;
}

/**
 * One local day, newest first, all-day events on top.
 *
 * Tombstones are filtered out here rather than removed from the store:
 * dropping the row would drop its rev with it, and the rule that keeps a
 * late reply from resurrecting a deleted event depends on that rev being
 * there (spec 6.2).
 */
export async function eventsOnDate(scope: Scope, localDate: string): Promise<EventDto[]> {
  const rows = await (await db()).getAllFromIndex('events', 'by-scope-date', [scope, localDate]);

  return rows
    .map((row) => row.event)
    .filter((event) => event.deletedAt === null)
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
}

/** Everything held for a scope, oldest write first. For tests and debugging. */
export async function allEvents(scope: Scope): Promise<EventDto[]> {
  const rows = await (await db()).getAllFromIndex(
    'events',
    'by-scope-rev',
    IDBKeyRange.bound([scope, -Infinity], [scope, Infinity]),
  );
  return rows.map((row) => row.event);
}

/**
 * Everything waiting to be sent for one account and baby, oldest first.
 *
 * Ordered by when each joined the queue, not by the key. An index gives
 * back its matches in primary-key order, which here is the event id -- a
 * random UUID, so the queue would drain in an order with no relation to
 * the order a parent recorded things in.
 */
export async function listQueued(scope: Scope): Promise<QueuedCreate[]> {
  const rows = await (await db()).getAllFromIndex('outbox', 'by-scope', scope);
  return rows.sort((a, b) => a.queuedAt - b.queuedAt || (a.eventId < b.eventId ? -1 : 1));
}

export async function getQueued(scope: Scope, eventId: string): Promise<QueuedCreate | null> {
  return (await (await db()).get('outbox', [scope, eventId])) ?? null;
}

export async function putQueued(entry: QueuedCreate): Promise<void> {
  await (await db()).put('outbox', entry);
}

export async function removeQueued(scope: Scope, eventId: string): Promise<void> {
  await (await db()).delete('outbox', [scope, eventId]);
}

/**
 * Puts an add into the queue, keeping what the queue already knew about it.
 *
 * The content is replaced, because a correction is the one thing a person
 * may change about a waiting entry, and the counters are reset, because
 * asking for it again by hand is a fresh start (spec 6.1). What survives is
 * `outcomeUnknown`: it is sticky, and an entry that has ever ended in
 * silence is still in doubt no matter how many times it is resent.
 *
 * Read and write in one transaction. Two mounts racing here would
 * otherwise both see nothing and both write a first attempt, and the later
 * one would carry `outcomeUnknown: false` over an entry that was in doubt.
 */
export async function enqueue(
  entry: Omit<QueuedCreate, 'outcomeUnknown' | 'attempts' | 'nextAttemptAt' | 'state' | 'lastCode' | 'queuedAt'>,
  now: number,
): Promise<QueuedCreate> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  const existing = await tx.store.get([entry.scope, entry.eventId]);

  const next: QueuedCreate = {
    ...entry,
    outcomeUnknown: existing?.outcomeUnknown ?? false,
    attempts: 0,
    nextAttemptAt: now,
    state: 'queued',
    lastCode: null,
    queuedAt: existing?.queuedAt ?? now,
  };

  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * Adds an entry only if that scope and id are not already held.
 *
 * For the migration out of the old store, which may run again after a
 * crash between writing here and clearing there. The entry already in the
 * queue is the one that has been attempted, counted and possibly marked;
 * overwriting it with the migration's fresh copy would reset all of that,
 * and reset `outcomeUnknown` with it.
 */
export async function queueIfAbsent(entry: QueuedCreate): Promise<boolean> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  const existing = await tx.store.get([entry.scope, entry.eventId]);
  if (!existing) await tx.store.put(entry);
  await tx.done;
  return !existing;
}
