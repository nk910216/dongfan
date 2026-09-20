import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { MOCK_BABY, MOCK_EVENTS } from '../mock/data.js';
import type { MockBaby, MockEvent } from '../mock/data.js';
import { deriveSummary, todaysEvents } from '../mock/derive.js';
import type { Summary } from '../mock/derive.js';

/**
 * Application state for the UI prototype.
 *
 * Backed by mock data today. The shape mirrors what the API will return so
 * that swapping in the real client replaces this module without touching the
 * components (spec 12.1 requires that swap before M1 is complete).
 */

export type NewEventInput = {
  typeId: string;
  intent: 'start_timer' | 'record';
  startedAt: number;
  endedAt: number | null;
  value: number;
  note: string;
  metadata: Record<string, string>;
};

type Store = {
  baby: MockBaby;
  events: MockEvent[];
  summary: Summary;
  now: number;
  addEvent: (input: NewEventInput) => void;
  stopTimer: (eventId: string) => void;
};

const StoreContext = createContext<Store | null>(null);

/** Client-generated ids double as the idempotency key (spec 3.8). */
function newEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  // randomUUID needs a secure context, which a phone on a LAN IP over plain
  // HTTP is not. Falling back keeps the spec 12.1 phone check possible.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [events, setEvents] = useState<MockEvent[]>(MOCK_EVENTS);
  const [now, setNow] = useState(() => Date.now());

  // One interval drives every elapsed display, rather than one per component.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const addEvent = useCallback((input: NewEventInput) => {
    setEvents((current) => [
      {
        id: newEventId(),
        typeId: input.typeId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        active: input.intent === 'start_timer',
        value: input.value,
        note: input.note,
        metadata: input.metadata,
        intent: input.intent,
      },
      ...current,
    ]);
  }, []);

  const stopTimer = useCallback((eventId: string) => {
    setEvents((current) =>
      current.map((e) => (e.id === eventId ? { ...e, active: false, endedAt: Date.now() } : e)),
    );
  }, []);

  const value = useMemo<Store>(
    () => ({
      baby: MOCK_BABY,
      events,
      summary: deriveSummary(events, MOCK_BABY, now),
      now,
      addEvent,
      stopTimer,
    }),
    [events, now, addEvent, stopTimer],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore used outside StoreProvider');
  return store;
}

export function useTodaysEvents(): MockEvent[] {
  const { events, baby, now } = useStore();
  return useMemo(() => todaysEvents(events, baby, now), [events, baby, now]);
}
