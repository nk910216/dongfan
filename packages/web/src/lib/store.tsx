import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getEventType, toLocalDate, zhTW } from '@dongfan/shared';
import { Message } from '../components/Message.js';
import type { BabyDto, EventDto, EventIntent, SummaryDto, TypeSummaryDto } from '@dongfan/shared';
import { ApiFailure, apiRequest } from './api.js';
import * as local from './db.js';
import { scopeOf } from './db.js';
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
 * Writes still go straight to the server. The queue that lets them wait is
 * the next stage; a half-built one is worse than none, because it would
 * look like it was keeping a parent's records safe.
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
  refresh: () => Promise<void>;
  /**
   * One event. Local when we have it, unless `fresh` is asked for.
   *
   * `fresh` exists for the reload after a version conflict: the local copy
   * is by definition the stale one, and handing it back would send the same
   * version again and collect the same 409 (spec 6.3).
   */
  findEvent: (eventId: string, options?: { fresh?: boolean }) => Promise<EventDto>;
  /**
   * The id is the caller's, not this function's. Generating one here would
   * mean a second press after a failure created a second event, which is
   * the one thing idempotency exists to prevent (spec 3.8, 6.1).
   */
  addEvent: (eventId: string, input: NewEventInput) => Promise<EventDto>;
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
  const scope = scopeOf(me?.user.id ?? '', baby.id);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
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
    const [day, meta] = await Promise.all([
      local.eventsOnDate(scope, today),
      local.readMeta(scope),
    ]);
    setEvents(allDayFirst(day));
    setSyncedAt(meta.syncedAt);
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

    await syncEvents(scope, baby.id, call);
    const next = await syncSummary(scope, baby.id, call);

    setEvents(allDayFirst(await local.eventsOnDate(scope, today)));
    setSummary(next);
    setSyncedAt((await local.readMeta(scope)).syncedAt);
  }, [call, readLocal, scope, baby.id, today]);

  // Kept in a ref so a mutation can refresh without depending on a callback
  // that changes identity every time the date string does.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    refresh()
      .then(() => {
        if (!cancelled) setStale(false);
      })
      .catch(async () => {
        if (cancelled) return;
        // The network is gone, which is not the same as having nothing to
        // show. Whatever was pulled before is still here.
        setStale(true);
        await readLocal().catch(() => undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refresh, attempt]);

  /**
   * Refetches after a write, and whenever something says to.
   *
   * Everything for this baby, not a computed subset: the cost of refetching
   * two small responses is far below the cost of getting the subset wrong.
   */
  const settle = useCallback(async (): Promise<void> => {
    setSyncing(true);
    try {
      await refreshRef.current();
      setStale(false);
    } catch {
      setStale(true);
    } finally {
      setSyncing(false);
    }
  }, []);

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
    };

    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [settle]);

  const addEvent = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto> => {
      const created = await call<EventDto>(`/babies/${baby.id}/events`, {
        method: 'POST',
        body: { id: eventId, ...input },
      });
      // Kept before the sync is attempted. The write succeeded; if the pull
      // that follows does not, the record must still be here rather than
      // vanishing from a screen that just said it was saved.
      await local.applyOne(scope, created);
      await settle();
      return created;
    },
    [call, baby.id, scope, settle],
  );

  const updateEvent = useCallback(
    async (eventId: string, version: number, patch: EventPatch): Promise<EventDto> => {
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

  const value = useMemo<Store>(
    () => ({
      baby, events, summary: summary as SummaryDto, now, loading, stale, syncing, syncedAt,
      refresh: settle, findEvent, addEvent, updateEvent, stopTimer, removeEvent,
    }),
    [baby, events, summary, now, loading, stale, syncing, syncedAt, settle, findEvent, addEvent, updateEvent, stopTimer, removeEvent],
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
