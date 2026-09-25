import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { addLocalDays, coversLocalDate, msOnLocalDate } from '@dongfan/shared';
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
const DB_VERSION = 3;

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

/**
 * The moment a timer was actually stopped, kept until somebody confirms it.
 *
 * The queue takes creations only, so pressing stop with no signal has
 * nowhere to go. Refusing outright and asking the parent to remember the
 * time is what destroys the data: somebody presses stop at 03:10, the
 * signal comes back at 03:40, and the sleep is recorded half an hour long
 * -- and sleep length is what this app is for (spec 7.2).
 *
 * So the real instant is written down here, and offered back for
 * confirmation once there is a connection. Not submitted automatically:
 * the other parent may have stopped or edited the same timer in the
 * meantime, and only a person can decide what to do about that.
 */
export type StopDraft = {
  scope: Scope;
  eventId: string;
  /** The real moment the button was pressed, not when it is sent. */
  endedAt: number;
  /**
   * The version the event carried when the button was pressed.
   *
   * Never sent: the update has to carry whatever version the server holds
   * when it is finally confirmed. It is here so the confirmation screen
   * can say that somebody else has touched this event since (spec 6.3).
   */
  version: number;
  createdAt: number;
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
  drafts: {
    key: [Scope, string];
    value: StopDraft;
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

      if (!database.objectStoreNames.contains('drafts')) {
        const drafts = database.createObjectStore('drafts', { keyPath: ['scope', 'eventId'] });
        drafts.createIndex('by-scope', 'scope');
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

/**
 * Whether this device holds a row for that id at all.
 *
 * Tombstones count. The question is whether the server ever took the
 * record, and a deleted one was taken and then removed -- offering its
 * content back to be created again would resurrect something somebody
 * deliberately got rid of.
 */
export async function hasEvent(scope: Scope, id: string): Promise<boolean> {
  return (await (await db()).getKey('events', [scope, id])) !== undefined;
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

/**
 * One entry on a day's calendar.
 *
 * `carriedOver` is not decoration. The sleep shown at the top of the 21st
 * began the evening before and is *counted* on the 20th, so a screen that
 * let it look like a record of the 21st would disagree with every figure
 * next to it.
 */
export type DayEntry = {
  readonly event: EventDto;
  /** Started on an earlier day and ran into this one. */
  readonly carriedOver: boolean;
  /** Milliseconds of it inside this day. Zero while it is still running. */
  readonly msOnDay: number;
};

/**
 * One local day for the calendar: its own events, plus what ran into it.
 *
 * Deliberately not `eventsOnDate`. That one answers "what is counted on
 * this day", which is what the home screen shows beside figures computed
 * the same way. This one answers "what was happening on this day", which
 * is what a calendar is, and the two differ by exactly one thing: a sleep
 * that began before midnight (spec 3.4.1, 7.5).
 *
 * Only the previous day is looked at, and that is a consequence rather
 * than an assumption: an event lasts at most 24 hours, so it crosses
 * midnight at most once (spec 3.4.1 rule 1). If that limit ever moves,
 * this has to widen with it.
 */
export async function calendarDay(
  scope: Scope,
  date: string,
  timeZone: string,
): Promise<DayEntry[]> {
  const store = (await db()).transaction('events').store.index('by-scope-date');
  const [onDay, dayBefore] = await Promise.all([
    store.getAll([scope, date]),
    store.getAll([scope, addLocalDays(date, -1)]),
  ]);

  return [...onDay, ...dayBefore]
    .map((row) => row.event)
    .filter((event) => event.deletedAt === null)
    .filter((event) =>
      coversLocalDate(event.localDate, event.startedAt, event.endedAt, date, timeZone))
    .map((event) => ({
      event,
      carriedOver: event.localDate !== date,
      msOnDay: msOnLocalDate(event.startedAt, event.endedAt, date, timeZone),
    }))
    .sort((a, b) =>
      b.event.startedAt - a.event.startedAt || (a.event.id < b.event.id ? 1 : -1));
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
 * Why a correction was not taken.
 *
 * Returned rather than thrown, because deciding what it means to the
 * person at the screen is not this layer's job.
 */
export type CorrectionRefusal = 'gone' | 'in-doubt';

export type Correction =
  | { ok: true; entry: QueuedCreate }
  | { ok: false; reason: CorrectionRefusal };

/**
 * Replaces the content of a waiting entry, if it is still allowed to be
 * replaced.
 *
 * Checked and written inside one transaction, and that is the whole point
 * of the function existing. Reading the entry, deciding it is safe to
 * correct, and writing the new content in a second transaction leaves a
 * gap that `beginSend` fits through exactly: the correction reads "no
 * doubt", the send marks the doubt and takes the original 80 ml to the
 * server, and then the correction writes 100 ml over the entry it was
 * never allowed to touch. The response to the 80 arrives, the entry is
 * removed, and the 100 is gone (spec 6.1).
 *
 * Two readwrite transactions over the same store cannot interleave, so one
 * of the two always loses cleanly: either the correction lands and the
 * send takes the corrected content, or the send starts and the correction
 * is refused.
 *
 * The counters are reset because a person asked for this, and
 * `outcomeUnknown` is untouched -- it is false here by definition, since a
 * true one is what this refuses.
 */
export async function correctQueuedEntry(
  scope: Scope,
  eventId: string,
  input: NewEventInput,
  now: number,
): Promise<Correction> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  const existing = await tx.store.get([scope, eventId]);

  if (!existing) {
    await tx.done;
    return { ok: false, reason: 'gone' };
  }
  if (existing.outcomeUnknown) {
    await tx.done;
    return { ok: false, reason: 'in-doubt' };
  }

  const corrected: QueuedCreate = {
    ...existing,
    input,
    attempts: 0,
    nextAttemptAt: now,
    state: 'queued',
    lastCode: null,
  };
  await tx.store.put(corrected);
  await tx.done;
  return { ok: true, entry: corrected };
}

/**
 * Puts a stopped entry back in the queue, unchanged.
 *
 * Read and written in one transaction for the same reason as above.
 *
 * It takes no content, and that absence is the point rather than a check
 * that could be got wrong: "send this again" cannot mean "send what it
 * said when I read it", because a copy read a moment ago may have been
 * corrected since. There is no parameter here to pass a stale one
 * through.
 */
export async function requeue(
  scope: Scope,
  eventId: string,
  now: number,
): Promise<QueuedCreate | null> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  const existing = await tx.store.get([scope, eventId]);

  if (!existing) {
    await tx.done;
    return null;
  }

  const requeued: QueuedCreate = {
    ...existing,
    attempts: 0,
    nextAttemptAt: now,
    state: 'queued',
    lastCode: null,
  };
  await tx.store.put(requeued);
  await tx.done;
  return requeued;
}

/**
 * Marks an entry as being in doubt, and hands back what to send.
 *
 * Called immediately before a request leaves, in its own transaction,
 * because the window it covers is the one that loses corrections. Between
 * a POST reaching the server and its response reaching the device the
 * event exists and this device does not know it. An entry that still said
 * "no doubt" through that window would let somebody correct it from the
 * list, or let a browser killed mid-request reopen offering a correction
 * -- and a corrected POST under an id the server already holds comes back
 * as the stored event, so the correction disappears with nothing on screen
 * to say so (spec 6.1).
 *
 * What comes back is the row as stored, and that is what gets sent. The
 * copy the caller was holding may have been corrected since it was read.
 *
 * Null means the entry is no longer there, which is somebody having
 * abandoned it; nothing is put back.
 */
export async function beginSend(scope: Scope, eventId: string): Promise<QueuedCreate | null> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  const existing = await tx.store.get([scope, eventId]);

  if (!existing) {
    await tx.done;
    return null;
  }

  const sending: QueuedCreate = { ...existing, outcomeUnknown: true };
  await tx.store.put(sending);
  await tx.done;
  return sending;
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

/**
 * Every unconfirmed stop for one account and baby, oldest first.
 *
 * At most one per event, because a second press of the same stop button
 * means the same thing as the first and must not become a second record of
 * when it happened.
 */
export async function listDrafts(scope: Scope): Promise<StopDraft[]> {
  const rows = await (await db()).getAllFromIndex('drafts', 'by-scope', scope);
  return rows.sort((a, b) => a.createdAt - b.createdAt || (a.eventId < b.eventId ? -1 : 1));
}

export async function getDraft(scope: Scope, eventId: string): Promise<StopDraft | null> {
  return (await (await db()).get('drafts', [scope, eventId])) ?? null;
}

/**
 * Writes down when a timer was stopped, unless that is already recorded.
 *
 * The first press is the one that counts. Pressing again five minutes
 * later, having watched nothing happen, must not move the recorded moment
 * five minutes later with it -- the whole point is to keep the instant the
 * parent acted (spec 7.2).
 */
export async function keepDraft(draft: StopDraft): Promise<StopDraft> {
  const database = await db();
  const tx = database.transaction('drafts', 'readwrite');
  const existing = await tx.store.get([draft.scope, draft.eventId]);

  const kept = existing ?? draft;
  if (!existing) await tx.store.put(draft);
  await tx.done;
  return kept;
}

export async function removeDraft(scope: Scope, eventId: string): Promise<void> {
  await (await db()).delete('drafts', [scope, eventId]);
}

/**
 * Drops the drafts that no longer have anything to ask.
 *
 * Two ways that happens, and the first is the one that matters. A stop can
 * reach the server and lose its response on the way back: the update
 * landed, this device never heard so, and the moment is still sitting here
 * waiting to be confirmed. The next pull brings the event back already
 * ending at exactly the instant this draft holds -- the server's state is
 * what the draft was asking for, so there is nothing left to ask.
 *
 * The test is on the state, not on who produced it. Whether this device's
 * request arrived or somebody else set the same instant, the answer to
 * "should this timer end here?" is already yes, and offering it again
 * would ask a question that has been settled.
 *
 * Without this the parent is told another family member ended it, at the
 * very time they pressed the button themselves.
 *
 * The second is a deleted event: there is no timer left to end.
 *
 * An event that has not been pulled yet is left alone. Absent is not the
 * same as answered.
 */
export async function reconcileDrafts(scope: Scope): Promise<StopDraft[]> {
  const database = await db();
  const tx = database.transaction(['drafts', 'events'], 'readwrite');
  const drafts = tx.objectStore('drafts');
  const events = tx.objectStore('events');

  for (const draft of await drafts.index('by-scope').getAll(scope)) {
    const row = await events.get([scope, draft.eventId]);
    if (!row) continue;
    if (row.event.deletedAt !== null || row.event.endedAt === draft.endedAt) {
      await drafts.delete([scope, draft.eventId]);
    }
  }

  await tx.done;
  return listDrafts(scope);
}
