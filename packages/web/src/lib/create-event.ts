import { useCallback, useState } from 'react';
import type { EventDto } from '@dongfan/shared';
import { outcomeIsUnknown, provesNotStored } from './outcome.js';
import { forgetPending, pendingFor, rememberPending } from './pending-create.js';
import { useSession } from './session.js';
import { newClientId } from './ids.js';
import { useStore } from './store.js';
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
 * in silence is written to storage and marked unresolved, and until the
 * server says something definite the only thing the caller may do is resend
 * what was sent before, unchanged.
 *
 * This is not the offline queue. That belongs to M2, with its own storage
 * and its own backoff. This is only the rule that a retry in front of the
 * parent cannot quietly duplicate their record.
 */

export type CreateEvent = {
  busy: boolean;
  /** True when an attempt ended without the server saying anything. */
  outcomeUnknown: boolean;
  /** What that attempt sent. The screen shows this rather than a new draft. */
  pending: NewEventInput | null;
  failure: unknown;
  /**
   * Sends the draft, or -- once the outcome is unknown -- resends exactly
   * what was sent before, whatever is passed in.
   */
  submit: (input: NewEventInput) => Promise<EventDto | null>;
  /**
   * Resends the captured payload, for a caller that has a draft it must
   * not consult. Falls back to `submit` when there is nothing captured.
   */
  retry: () => Promise<EventDto | null>;
};

export function useCreateEvent(typeId: string): CreateEvent {
  const { addEvent, baby } = useStore();
  const { me } = useSession();
  const userId = me?.user.id ?? '';

  // Picked up from storage when it belongs to this user, this baby and
  // this type. A nappy shortcut must not resend somebody's bottle.
  const [resumed] = useState(() => pendingFor(userId, baby.id, typeId));

  const [eventId] = useState(() => resumed?.eventId ?? newClientId());
  const [sent, setSent] = useState<NewEventInput | null>(resumed?.input ?? null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(resumed !== null);
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
        setSent(null);
        // This add and no other. A nappy going through says nothing about
        // a bottle still waiting to be confirmed.
        forgetPending(userId, baby.id, eventId);
        setBusy(false);
        return created;
      } catch (error) {
        setFailure(error);
        setBusy(false);

        // Once in doubt, only a refusal the server could not have given
        // for a stored event settles it. Every other answer -- including
        // the ones that look definite -- leaves it exactly where it was.
        if (outcomeUnknown) {
          if (provesNotStored(error)) {
            setOutcomeUnknown(false);
            setSent(null);
            forgetPending(userId, baby.id, eventId);
          }
          return null;
        }

        if (outcomeIsUnknown(error)) {
          setSent(payload);
          setOutcomeUnknown(true);
          // Written down before the screen has a chance to disappear,
          // which a 401 makes it do immediately.
          rememberPending({ userId, babyId: baby.id, eventId, input: payload });
        }
        return null;
      }
    },
    [addEvent, eventId, outcomeUnknown, sent, userId, baby.id],
  );

  const retry = useCallback(
    (): Promise<EventDto | null> => (sent === null ? Promise.resolve(null) : submit(sent)),
    [sent, submit],
  );

  return { busy, outcomeUnknown, pending: sent, failure, submit, retry };
}
