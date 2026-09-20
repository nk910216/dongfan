import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getEventType, toLocalDate, zhTW } from '@dongfan/shared';
import { Message } from '../components/Message.js';
import type { BabyDto, DayDto, EventDto, EventIntent, SummaryDto, TypeSummaryDto } from '@dongfan/shared';
import { ApiFailure, apiRequest } from './api.js';
import { useSession } from './session.js';

/**
 * The screens' data, read from the API.
 *
 * Deliberately thin: today's list and the summary, refetched after every
 * write. Narrowing the invalidation would be guesswork, because a sleep that
 * began last night changes today's figures too, and a corrected timestamp
 * changes two days at once (spec 6.2).
 *
 * There is no offline queue and no IndexedDB here. Both belong to M2, and a
 * half-built queue is worse than none: it would look like it was keeping a
 * parent's records safe.
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
  refresh: () => Promise<void>;
  findEvent: (eventId: string) => Promise<EventDto>;
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
  const { token, expire } = useSession();
  const [events, setEvents] = useState<EventDto[]>([]);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
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

  const refresh = useCallback(async () => {
    const [day, next] = await Promise.all([
      call<DayDto>(`/babies/${baby.id}/events/day/${today}`),
      call<SummaryDto>(`/babies/${baby.id}/events/summary`),
    ]);
    setEvents(allDayFirst(day.events));
    setSummary(next);
  }, [call, baby.id, today]);

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
      .catch(() => {
        if (!cancelled) setStale(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refresh, attempt]);

  /**
   * Refetches after a write.
   *
   * Everything for this baby, not a computed subset: the cost of refetching
   * two small responses is far below the cost of getting the subset wrong.
   */
  const settle = useCallback(async (): Promise<void> => {
    try {
      await refreshRef.current();
      setStale(false);
    } catch {
      setStale(true);
    }
  }, []);

  const addEvent = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto> => {
      const created = await call<EventDto>(`/babies/${baby.id}/events`, {
        method: 'POST',
        body: { id: eventId, ...input },
      });
      await settle();
      return created;
    },
    [call, baby.id, settle],
  );

  const updateEvent = useCallback(
    async (eventId: string, version: number, patch: EventPatch): Promise<EventDto> => {
      const updated = await call<EventDto>(`/events/${eventId}`, {
        method: 'PATCH',
        body: { version, ...patch },
      });
      await settle();
      return updated;
    },
    [call, settle],
  );

  const stopTimer = useCallback(
    (eventId: string, version: number, endedAt: number): Promise<EventDto> =>
      updateEvent(eventId, version, { endedAt }),
    [updateEvent],
  );

  const removeEvent = useCallback(
    async (eventId: string, version: number): Promise<void> => {
      await call(`/events/${eventId}`, { method: 'DELETE', body: { version } });
      await settle();
    },
    [call, settle],
  );

  const findEvent = useCallback(
    (eventId: string): Promise<EventDto> => call<EventDto>(`/events/${eventId}`),
    [call],
  );

  const value = useMemo<Store>(
    () => ({
      baby, events, summary: summary as SummaryDto, now, loading, stale,
      refresh: settle, findEvent, addEvent, updateEvent, stopTimer, removeEvent,
    }),
    [baby, events, summary, now, loading, stale, settle, findEvent, addEvent, updateEvent, stopTimer, removeEvent],
  );

  // Nothing below this point has to cope with an absent summary. Gating here
  // rather than threading a null through every screen keeps "we have not
  // loaded yet" from looking like "there is nothing recorded".
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
