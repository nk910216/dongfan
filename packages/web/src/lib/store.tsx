import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getEventType, toLocalDate, zhTW } from '@dongfan/shared';
import { Message } from '../components/Message.js';
import type { BabyDto, EventDto, SummaryDto, TypeSummaryDto } from '@dongfan/shared';
import { ApiFailure, OfflineError, apiRequest, isOffline } from './api.js';
import * as local from './db.js';
import { listQueued, scopeOf } from './db.js';
import type { NewEventInput, QueuedCreate } from './db.js';
import { runExclusive } from './lane.js';
import {
  abandonQueued, attemptQueued, correctQueued, ensureMigrated, queueAdd, retryQueued, runOutbox,
} from './outbox.js';
import type { Send } from './outbox.js';
import { syncEvents, syncSummary } from './sync.js';
import { useSession } from './session.js';

/**
 * The screens' data.
 *
 * Read from the local database, filled by pulling changes from the server.
 * The screens never wait on the network to show something they already
 * have, which is what makes the app usable on a train and at three in the
 * morning in a room with no signal (spec 6.2).
 *
 * The summary is the exception and stays the server's: what changes when an
 * event moves is not something a client can work out, so it is fetched and
 * cached, and shown as old rather than as current when the fetch fails
 * (spec 5.5, 6.2).
 *
 * Adds go through the queue in `outbox.ts`, which means they are written
 * down before anything is sent and survive whatever happens next. Edits
 * and deletions do not: offline they are refused outright, because the
 * version they carry would be stale by the time they left and the answer
 * to the conflict that follows is a question for somebody who is asleep
 * (spec 6.1).
 */

/**
 * Re-exported from the storage layer, where it is defined.
 *
 * It is the shape of a queued add as much as the shape of a form, and the
 * two must not be allowed to drift apart.
 */
export type { NewEventInput };

export type EventPatch = {
  startedAt?: number;
  endedAt?: number | null;
  value?: number;
  note?: string;
  metadata?: Record<string, string>;
};

export type Store = {
  baby: BabyDto;
  /** Today's events in the baby timezone, all-day first then newest first. */
  events: EventDto[];
  summary: SummaryDto;
  now: number;
  loading: boolean;
  /** Set when the last refresh did not reach the server. */
  stale: boolean;
  /** True while a pull is in progress. */
  syncing: boolean;
  /** When the last successful pull finished, or null if there never was one. */
  syncedAt: number | null;
  /**
   * Adds that have not reached the server, oldest first.
   *
   * On screen as a count and as a list, never implied: storage here can be
   * cleared by the browser without warning, so "we are holding four of
   * your records" is something a parent has to be told (spec 6.1, 9.6).
   */
  unsynced: QueuedCreate[];
  refresh: () => Promise<void>;
  /**
   * Sends one waiting add now, exactly as it stands, and resets its
   * counters.
   *
   * The content comes from the entry, not from a screen. That is the whole
   * point when the outcome is unknown: what has to go back is what went
   * before, and an entry can say what that was long after the form that
   * produced it has gone (spec 6.1).
   */
  retryUnsynced: (eventId: string) => Promise<EventDto | null>;
  /**
   * Replaces the content of a waiting add and sends it.
   *
   * Refused while its outcome is unknown; see `correctQueued`.
   */
  correctUnsynced: (eventId: string, input: NewEventInput) => Promise<EventDto | null>;
  /** Stops trying. Says nothing about whether the server has it. */
  abandonUnsynced: (eventId: string) => Promise<void>;
  /**
   * One event. Local when we have it, unless `fresh` is asked for.
   *
   * `fresh` exists for the reload after a version conflict: the local copy
   * is by definition the stale one, and handing it back would send the same
   * version again and collect the same 409 (spec 6.3).
   */
  findEvent: (eventId: string, options?: { fresh?: boolean }) => Promise<EventDto>;
  /**
   * Queues an add and, unless the device is plainly offline, tries to send
   * it there and then.
   *
   * The id is the caller's, not this function's. Generating one here would
   * mean a second press after a failure created a second event, which is
   * the one thing idempotency exists to prevent (spec 3.8, 6.1).
   *
   * Returns the stored event, or null when it is waiting in the queue.
   * A refusal from the server is thrown, because somebody is looking at
   * the screen and can do something about it.
   */
  addEvent: (eventId: string, input: NewEventInput) => Promise<EventDto | null>;
  updateEvent: (eventId: string, version: number, patch: EventPatch) => Promise<EventDto>;
  stopTimer: (eventId: string, version: number, endedAt: number) => Promise<EventDto>;
  removeEvent: (eventId: string, version: number) => Promise<void>;
};

const StoreContext = createContext<Store | null>(null);

/** All-day events sit above the timed ones; the server sorted the rest. */
function allDayFirst(events: EventDto[]): EventDto[] {
  const allDay = events.filter((e) => getEventType(e.typeId)?.allDay === true);
  return allDay.length === 0 ? events : [...allDay, ...events.filter((e) => !allDay.includes(e))];
}

export function StoreProvider({ baby, children }: { baby: BabyDto; children: ReactNode }): React.JSX.Element {
  const { token, expire, me } = useSession();
  // One account, one baby. Everything below reads and writes under this,
  // so switching accounts cannot show the previous one's records and a
  // record cannot be filed against the wrong baby (spec 6.1, 6.2).
  const userId = me?.user.id ?? '';
  const scope = scopeOf(userId, baby.id);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [unsynced, setUnsynced] = useState<QueuedCreate[]>([]);
  // When the queue should wake up next. Null while there is nothing
  // waiting, and null while it is paused, which is what stops a timer
  // firing against a session that has already been rejected.
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // One interval drives every elapsed display, rather than one per component.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The date comes from the baby's timezone, never the device's. Held as a
  // string so the hourly ticks above do not retrigger the fetch below.
  const today = toLocalDate(now, baby.timezone);

  /**
   * An expired session must sign the app out rather than surface as an
   * error on a screen the user can no longer load anything into.
   */
  const call = useCallback(
    async <T,>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
      try {
        return await apiRequest<T>(path, { ...options, token: token ?? undefined });
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 401) expire();
        throw error;
      }
    },
    [token, expire],
  );

  /** Shows whatever is already here, without asking the network. */
  const readLocal = useCallback(async () => {
    const [day, meta, queued] = await Promise.all([
      local.eventsOnDate(scope, today),
      local.readMeta(scope),
      listQueued(scope),
    ]);
    setEvents(allDayFirst(day));
    setSyncedAt(meta.syncedAt);
    setUnsynced(queued);
    if (meta.summary) setSummary(meta.summary);
    return meta;
  }, [scope, today]);

  /**
   * Local first, then the network.
   *
   * The order is the point: a screen that has yesterday's data shows it
   * immediately and corrects itself, rather than showing a spinner over
   * records that are sitting on the device.
   */
  const refresh = useCallback(async () => {
    await readLocal();

    const { cursor } = await syncEvents(scope, baby.id, call);
    // Tagged with the cursor it was fetched at, which is the only thing
    // that orders two summaries.
    await syncSummary(scope, baby.id, call, cursor);

    // Everything on screen comes back out of the database rather than from
    // the replies that were just received. A reply can be refused for being
    // older than what is stored, and showing it anyway would leave the
    // screen and the device disagreeing until the next reload.
    const meta = await local.readMeta(scope);
    setEvents(allDayFirst(await local.eventsOnDate(scope, today)));
    setUnsynced(await listQueued(scope));
    if (meta.summary) setSummary(meta.summary);
    setSyncedAt(meta.syncedAt);
  }, [call, readLocal, scope, baby.id, today]);

  // Kept in a ref so a trigger can refresh without depending on a callback
  // that changes identity every time the date string does.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Through the same lane as every other trigger. Calling refresh
    // directly here was the one entrance that bypassed it, so a first sync
    // slow enough to still be running when the app came to the front, or
    // when something was written, overlapped with the sync that caused --
    // which is exactly the situation the lane exists for.
    runExclusive(scope, async () => {
      setSyncing(true);
      try {
        await refreshRef.current();
        if (!cancelled) setStale(false);
      } catch {
        if (cancelled) return;
        // The network is gone, which is not the same as having nothing to
        // show. Whatever was pulled before is still here.
        setStale(true);
        await readLocal().catch(() => undefined);
      } finally {
        setSyncing(false);
        if (!cancelled) setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refresh, readLocal, scope, attempt]);

  /**
   * Refetches after a write, and whenever something says to.
   *
   * Everything for this baby, not a computed subset: the cost of refetching
   * two small responses is far below the cost of getting the subset wrong.
   */
  const settle = useCallback(async (): Promise<void> => {
    // One at a time for this baby. Four things ask for a sync and none of
    // them knew about the others, so the one that answered last won -- and
    // that is not the one that asked last. A request arriving during a run
    // is queued rather than dropped, because a record written during a slow
    // pull needs the refresh it asked for.
    await runExclusive(scope, async () => {
      setSyncing(true);
      try {
        await refreshRef.current();
        setStale(false);
      } catch {
        setStale(true);
      } finally {
        setSyncing(false);
      }
    });
  }, [scope]);

  /**
   * The one way an add leaves this device.
   *
   * Handed to the queue rather than called by it, so that nothing in
   * `outbox.ts` knows about tokens, paths or the session -- and so the
   * queue's rules can be tested without a network at all.
   */
  const send = useCallback<Send>(
    (eventId, input) =>
      call<EventDto>(`/babies/${baby.id}/events`, {
        method: 'POST',
        body: { id: eventId, ...input },
      }),
    [call, baby.id],
  );

  /**
   * Sends whatever the queue says is due.
   *
   * In its own lane, not the sync one: a queue working through ten entries
   * must not hold up the pull that shows what the other parent just
   * recorded, and neither may overlap with itself.
   *
   * The migration runs first, every time, because it is cheap when there
   * is nothing to move and because the first drain after an upgrade is
   * exactly when the entries it rescues matter most.
   */
  const drain = useCallback(async (): Promise<void> => {
    let sent = 0;

    await runExclusive(`outbox:${scope}`, async () => {
      await ensureMigrated();

      // Nothing is attempted while the device says it has no connection.
      // An attempt that cannot leave still fails, and a failure that
      // cannot leave would spend one of the ten and mark the entry as
      // possibly stored -- barring a parent from correcting a record that
      // certainly never went anywhere (spec 6.1). Coming back online is
      // one of the things that calls this, so nothing is left waiting on a
      // timer that was deliberately not armed.
      if (isOffline()) {
        setUnsynced(await listQueued(scope));
        setDueAt(null);
        return;
      }

      const result = await runOutbox(scope, send);
      sent = result.sent;
      setUnsynced(await listQueued(scope));
      // A paused queue arms no timer. It waits for the same person to sign
      // in again, which remounts everything below and starts it off
      // (spec 6.1).
      setDueAt(result.paused ? null : result.nextDueAt);
    });

    // Outside the queue's lane and through the sync one, or a drain and a
    // pull could run against each other.
    if (sent > 0) await settle();
  }, [scope, send, settle]);

  /**
   * Wakes the queue when the next entry falls due.
   *
   * One timer for the earliest of them rather than one each, and none at
   * all when nothing is waiting: a phone in a pocket should not be woken
   * to find out there is nothing to do.
   */
  useEffect(() => {
    if (dueAt === null) return;

    // A floor, so that an entry which somehow reports itself due on every
    // pass cannot turn this into a spin.
    const delay = Math.max(1_000, dueAt - Date.now());
    const timer = setTimeout(() => void drain(), delay);
    return () => clearTimeout(timer);
  }, [dueAt, drain]);

  /** First pass, once the app has an account and a baby. */
  useEffect(() => {
    void drain();
  }, [drain]);

  /**
   * Pulls again when the app comes back.
   *
   * Without this the only thing that syncs is this device's own writing.
   * The other parent records a feed, this phone is picked up an hour later,
   * and it shows the same screen it had -- with nothing to say it is out of
   * date, because as far as it knows nothing has happened (spec 6.1).
   *
   * `online` covers coming out of a tunnel; `visibilitychange` covers the
   * far more common case of a phone that was simply in a pocket.
   */
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'hidden') return;
      void settle();
      // The same two moments the queue has been waiting for. A phone that
      // was in a pocket through a tunnel has both a pull and a send to do.
      void drain();
    };

    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [settle, drain]);

  /**
   * Tries to send one entry that is already in the queue.
   *
   * Every add goes through here, whether it is new, being resent or being
   * corrected, and in all three cases the entry is in storage before the
   * request leaves. A refusal is thrown because somebody is looking at the
   * screen; the entry stays queued either way, so nothing at all depends
   * on what they do about it.
   */
  const push = useCallback(
    async (entry: QueuedCreate | null): Promise<EventDto | null> => {
      setUnsynced(await listQueued(scope));
      if (!entry) return null;

      // Nothing can have been sent, so nothing is in doubt. This is the
      // three-in-the-morning case the queue exists for, and it is also
      // what lets the entry still be corrected later (spec 6.1).
      if (isOffline()) {
        setDueAt(Date.now());
        return null;
      }

      const result = await attemptQueued(scope, entry, send);
      setUnsynced(await listQueued(scope));

      if (!result.ok) {
        setDueAt(result.entry.state === 'queued' ? result.entry.nextAttemptAt : null);
        throw result.error;
      }

      await settle();
      // Reaching the server says the connection is up, which is the best
      // moment there is to clear whatever else is waiting.
      void drain();
      return result.event;
    },
    [scope, send, settle, drain],
  );

  const addEvent = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto | null> => {
      // Written down before anything is sent, every time. The window
      // between pressing save and a request failing is where a record used
      // to be lost: a 401 takes the screen holding it away immediately,
      // and a browser killed in that moment took the event id with it.
      return push(await queueAdd(userId, baby.id, eventId, input));
    },
    [userId, baby.id, push],
  );

  const updateEvent = useCallback(
    async (eventId: string, version: number, patch: EventPatch): Promise<EventDto> => {
      // Refused rather than queued. An edit made offline carries the
      // version that was read offline, so it comes back 409 nearly every
      // time, and a 409 is answered by asking somebody who is asleep
      // (spec 6.1). Stopping a timer offline is the one case that genuinely
      // loses data this way, and it gets a draft of its own in the next
      // stage (spec 7.2) rather than a general offline edit queue.
      if (isOffline()) throw new OfflineError();

      const updated = await call<EventDto>(`/events/${eventId}`, {
        method: 'PATCH',
        body: { version, ...patch },
      });
      await local.applyOne(scope, updated);
      await settle();
      return updated;
    },
    [call, scope, settle],
  );

  const stopTimer = useCallback(
    (eventId: string, version: number, endedAt: number): Promise<EventDto> =>
      updateEvent(eventId, version, { endedAt }),
    [updateEvent],
  );

  const removeEvent = useCallback(
    async (eventId: string, version: number): Promise<void> => {
      // Same rule as editing, and for the same reason.
      if (isOffline()) throw new OfflineError();

      // The tombstone comes back, and storing it is what hides the event
      // even if the sync afterwards fails.
      const tombstone = await call<EventDto>(`/events/${eventId}`, {
        method: 'DELETE',
        body: { version },
      });
      await local.applyOne(scope, tombstone);
      await settle();
    },
    [call, scope, settle],
  );

  /**
   * One event, from here if we have it.
   *
   * Falling back to the network covers the event that has not been pulled
   * yet -- a link opened before the first sync finished, for instance. What
   * comes back is stored, so the next read does not have to ask again.
   */
  const findEvent = useCallback(
    async (eventId: string, options: { fresh?: boolean } = {}): Promise<EventDto> => {
      if (!options.fresh) {
        const held = await local.findEvent(scope, eventId);
        if (held) return held;
      }

      const fetched = await call<EventDto>(`/events/${eventId}`);
      await local.applyOne(scope, fetched);
      return fetched;
    },
    [call, scope],
  );

  /**
   * The three things a parent can do with a record that has not been sent.
   *
   * Each one writes to the queue first and then asks it to run, so what
   * happens next does not depend on the screen still being there.
   */
  const retryUnsynced = useCallback(
    async (eventId: string): Promise<EventDto | null> => push(await retryQueued(scope, eventId)),
    [scope, push],
  );

  const correctUnsynced = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto | null> =>
      push(await correctQueued(scope, eventId, input)),
    [scope, push],
  );

  const abandonUnsynced = useCallback(
    async (eventId: string): Promise<void> => {
      await abandonQueued(scope, eventId);
      setUnsynced(await listQueued(scope));
    },
    [scope],
  );

  const value = useMemo<Store>(
    () => ({
      baby, events, summary: summary as SummaryDto, now, loading, stale, syncing, syncedAt,
      unsynced, refresh: settle, findEvent, addEvent, updateEvent, stopTimer, removeEvent,
      retryUnsynced, correctUnsynced, abandonUnsynced,
    }),
    [baby, events, summary, now, loading, stale, syncing, syncedAt, unsynced, settle, findEvent,
      addEvent, updateEvent, stopTimer, removeEvent, retryUnsynced, correctUnsynced, abandonUnsynced],
  );

  // Nothing below this point has to cope with an absent summary. Gating here
  // rather than threading a null through every screen keeps "we have not
  // loaded yet" from looking like "there is nothing recorded". A cached one
  // from a previous run counts, which is what lets the app open offline.
  if (summary === null) {
    return loading
      ? <Message text={zhTW.app.loading} />
      : <Message text={zhTW.home.syncFailed} onRetry={() => setAttempt((n) => n + 1)} />;
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore used outside StoreProvider');
  return store;
}

/** The summary entry for one type, or null when nothing is recorded yet. */
export function typeSummary(summary: SummaryDto, typeId: string): TypeSummaryDto | null {
  return summary.types.find((entry) => entry.typeId === typeId) ?? null;
}
