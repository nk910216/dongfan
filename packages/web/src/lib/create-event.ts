import { useCallback, useState } from 'react';
import type { EventDto } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from './api.js';
import { newEventId, useStore } from './store.js';
import type { NewEventInput } from './store.js';

/**
 * One attempt to add one event, with its id held still across retries.
 *
 * The id is generated once and reused, because it is the key the server
 * deduplicates on: a second press after a failed save must reach the same
 * row, not make a new one (spec 3.8).
 *
 * The harder half is what happens when the attempt ends without an answer.
 * A lost response looks exactly like a refusal from here, but the two call
 * for opposite handling: if the event is already stored, sending corrected
 * content under the same id gets the *stored* version back, and the
 * correction disappears without a trace (spec 6.1). So an attempt that ends
 * in silence sets a sticky flag, and while it is set the only thing the
 * caller may do is resend what was sent before, unchanged, until the server
 * says something definite.
 *
 * This is not the offline queue. That belongs to M2, with its own storage
 * and its own backoff. This is only the rule that a retry in front of the
 * parent cannot quietly duplicate their record.
 */

export type CreateEvent = {
  /** True while a request is in flight. */
  busy: boolean;
  /** True when an attempt ended without the server saying anything. */
  outcomeUnknown: boolean;
  failure: unknown;
  /**
   * Sends the draft, or -- once the outcome is unknown -- resends exactly
   * what was sent before, whatever is passed in.
   */
  submit: (input: NewEventInput) => Promise<EventDto | null>;
};

/**
 * Whether an attempt tells us nothing about what the server did.
 *
 * A request that never arrived and a server that fell over midway are the
 * same thing from here: the event may or may not be stored.
 */
function outcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NetworkFailure) return true;
  return error instanceof ApiFailure && error.status >= 500;
}

/**
 * Whether an answer proves the server does not have the event.
 *
 * A later 4xx does not clear an existing doubt on its own: a session that
 * expired between the first attempt and the retry says nothing about
 * whether the first attempt landed, and neither does being asked to slow
 * down (spec 6.1).
 */
function provesNotStored(error: unknown): boolean {
  if (!(error instanceof ApiFailure)) return false;
  if (error.status === 401 || error.status === 429) return false;
  return error.status >= 400 && error.status < 500;
}

export function useCreateEvent(): CreateEvent {
  const { addEvent } = useStore();
  const [eventId] = useState(newEventId);
  const [sent, setSent] = useState<NewEventInput | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (input: NewEventInput): Promise<EventDto | null> => {
      // While the outcome is in doubt, the payload is not the caller's to
      // choose: only the original content can tell us what the server has.
      const payload = outcomeUnknown && sent ? sent : input;

      setBusy(true);
      setFailure(null);
      try {
        const created = await addEvent(eventId, payload);
        setOutcomeUnknown(false);
        setBusy(false);
        return created;
      } catch (error) {
        setFailure(error);
        setBusy(false);
        if (outcomeIsUnknown(error)) {
          setSent(payload);
          setOutcomeUnknown(true);
        } else if (provesNotStored(error)) {
          setOutcomeUnknown(false);
        }
        return null;
      }
    },
    [addEvent, eventId, outcomeUnknown, sent],
  );

  return { busy, outcomeUnknown, failure, submit };
}
