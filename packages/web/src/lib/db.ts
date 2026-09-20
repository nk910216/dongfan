import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { EventDto, SummaryDto } from '@dongfan/shared';

/**
 * The only thing on this device that persists.
 *
 * Events, the sync cursor and (from the next stage) the queue of writes
 * waiting to be sent all live here. The query cache above it is a view and
 * may be thrown away at any moment; this is what survives a reload, and it
 * is what "the app works on a train" means (spec 6.2).
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
const DB_VERSION = 1;

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
}

let handle: Promise<IDBPDatabase<DongfanDb>> | null = null;

export function db(): Promise<IDBPDatabase<DongfanDb>> {
  handle ??= openDB<DongfanDb>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const events = database.createObjectStore('events', { keyPath: ['scope', 'id'] });
      // Ordered by rev, which is how a page of the sync feed arrives and
      // the only ordering the server guarantees is a write order.
      events.createIndex('by-scope-rev', ['scope', 'rev']);
      // The home screen and the calendar both ask for one local day.
      events.createIndex('by-scope-date', ['scope', 'localDate']);

      database.createObjectStore('meta', { keyPath: 'scope' });
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
  summaryCursor: -1,
});

export async function readMeta(scope: Scope): Promise<SyncMeta> {
  return (await (await db()).get('meta', scope)) ?? EMPTY_META(scope);
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
): Promise<void> {
  const database = await db();
  const tx = database.transaction('meta', 'readwrite');
  const meta = (await tx.store.get(scope)) ?? EMPTY_META(scope);

  if (atCursor >= meta.summaryCursor) {
    await tx.store.put({ ...meta, summary, summaryAt: Date.now(), summaryCursor: atCursor });
  }

  await tx.done;
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
  const meta = (await metaStore.get(scope)) ?? EMPTY_META(scope);
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
