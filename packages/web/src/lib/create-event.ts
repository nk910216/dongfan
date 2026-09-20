import { useCallback, useState } from 'react';
import type { EventDto } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from './api.js';
import { clearPending, pendingFor, writePending } from './pending-create.js';
import { useSession } from './session.js';
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
};

/**
 * The refusals that prove the server does not have the event.
 *
 * A whitelist, not a list of exceptions, and a short one: these are the
 * only answers the create handler produces *after* its idempotency read
 * back. Reaching one of them means the server looked for this id, did not
 * find it, and went on to refuse the content (spec 5.8).
 *
 * Everything else leaves the doubt where it was. A session that expired, a
 * rate limit, an account removed from the baby between the first attempt
 * and the retry -- none of them say anything about whether the first
 * attempt landed, and a 404 from losing access is not evidence that the
 * record is absent. Nor is a code this build has never seen (spec 6.1).
 */
const PROVES_NOT_STORED = new Set([
  'VALIDATION_FAILED',
  'DAILY_LIMIT_EXCEEDED',
  'ACTIVE_TIMER_EXISTS',
  'ID_CONFLICT',
]);

function provesNotStored(error: unknown): boolean {
  return error instanceof ApiFailure && PROVES_NOT_STORED.has(error.code);
}

/**
 * Whether a first attempt tells us nothing about what the server did.
 *
 * A request that never arrived and a server that fell over midway are the
 * same thing from here: the event may or may not be stored. Only asked
 * when there is no doubt yet -- a 404 on a first attempt really is a
 * refusal before any write, and freezing the form over it would be a lie.
 */
function outcomeIsUnknown(error: unknown): boolean {
  if (error instanceof NetworkFailure) return true;
  return error instanceof ApiFailure && error.status >= 500;
}

export function useCreateEvent(typeId: string): CreateEvent {
  const { addEvent, baby } = useStore();
  const { me } = useSession();
  const userId = me?.user.id ?? '';

  // Picked up from storage when it belongs to this user, this baby and
  // this type. A nappy shortcut must not resend somebody's bottle.
  const [resumed] = useState(() => {
    const found = pendingFor(userId, baby.id);
    return found && found.input.typeId === typeId ? found : null;
  });

  const [eventId] = useState(() => resumed?.eventId ?? newEventId());
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
        clearPending();
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
            clearPending();
          }
          return null;
        }

        if (outcomeIsUnknown(error)) {
          setSent(payload);
          setOutcomeUnknown(true);
          // Written down before the screen has a chance to disappear,
          // which a 401 makes it do immediately.
          writePending({ userId, babyId: baby.id, eventId, input: payload });
        }
        return null;
      }
    },
    [addEvent, eventId, outcomeUnknown, sent, userId, baby.id],
  );

  return { busy, outcomeUnknown, pending: sent, failure, submit };
}
