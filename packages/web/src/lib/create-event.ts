import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventDto } from '@dongfan/shared';
import { EntryGone } from './outbox.js';
import { getQueued } from './db.js';
import type { QueuedCreate } from './db.js';
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
 * What this no longer does is hold the record. Everything a retry needs --
 * the id, the content that was sent, whether the outcome is in doubt --
 * lives in the queue, where it survives the screen being unmounted by a
 * 401, the tab being killed, and the phone being put down for an hour
 * (spec 6.1). This hook picks which of the queue's three doors to use and
 * reports what came back.
 *
 * Because of that, `outcomeUnknown` here is read from the queue on every
 * render rather than mirrored into state. A copy would be the second
 * source of truth this project keeps being bitten by, and it would go
 * stale the moment the queue retried in the background.
 */

export type SubmitResult =
  /** The server has it, and said so. */
  | { kind: 'sent'; event: EventDto }
  /** In the queue, not yet sent. Nothing more for this screen to do. */
  | { kind: 'queued' }
  /**
   * The queue sent it in the background while this screen was open, so a
   * correction typed here cannot go out as a creation any more: the server
   * would answer with the event it already has. It has to become an edit
   * (spec 6.1, 6.3).
   */
  | { kind: 'gone'; eventId: string }
  /**
   * It did not go through -- which is **not** the same as "the server does
   * not have it".
   *
   * This read "the server refused it" while every error landed here,
   * including a lost answer: the record may be stored, and the content is
   * the queue's until that is settled. A screen that took this as "handed
   * back" unlocked the form and let its draft be rewritten without the id
   * the record went out under (spec 3.8). Found in review.
   *
   * `inDoubt` is what the queue says about the entry after the attempt,
   * read back from it rather than inferred from the error: the queue is
   * what decides whether this may be retried, corrected or resent, and a
   * second classification of the same error here could only drift from it.
   */
  | { kind: 'failed'; inDoubt: boolean };

export type CreateEvent = {
  /**
   * The id this add will be sent under, fixed for the life of the screen.
   *
   * Exposed so that a form draft can be stamped with it at the moment the
   * content is handed over: once the queue has it under this id, the
   * draft has become a second copy, and restoring it later is how one
   * feed turns into two (spec 3.8).
   */
  eventId: string;
  busy: boolean;
  /** True when an attempt ended without the server saying anything. */
  outcomeUnknown: boolean;
  /**
   * The content of the entry this screen took over, so the form can show
   * what is actually waiting rather than an empty draft.
   */
  pending: NewEventInput | null;
  failure: unknown;
  /**
   * Sends the draft, or -- once the outcome is unknown -- sends exactly
   * what the queue holds, whatever is passed in.
   */
  submit: (input: NewEventInput) => Promise<SubmitResult>;
  /**
   * Sends what the queue holds, for a caller that has a draft it must not
   * consult.
   */
  retry: () => Promise<SubmitResult>;
};

/**
 * The waiting entry this screen should take over, if there is one.
 *
 * Named explicitly when the failure list sent us here. Otherwise the
 * oldest of this type that needs a person: one that is merely waiting its
 * turn is the queue's business, and hijacking the form with it would stop
 * a parent recording the next feed at all.
 */
function resumable(
  entries: readonly QueuedCreate[],
  typeId: string,
  eventId: string | undefined,
): QueuedCreate | null {
  if (eventId !== undefined) return entries.find((entry) => entry.eventId === eventId) ?? null;
  return (
    entries.find(
      (entry) =>
        entry.input.typeId === typeId && (entry.outcomeUnknown || entry.state === 'failed'),
    ) ?? null
  );
}

/**
 * @param eventId The id this screen is working under, when it already has
 * one: the entry the failure list sent it to correct, or the id a
 * restored draft was part way through being handed over as. Keeping it is
 * what stops a second attempt becoming a second record (spec 3.8).
 */
export function useCreateEvent(typeId: string, eventId?: string): CreateEvent {
  const { addEvent, retryUnsynced, correctUnsynced, unsynced, scope } = useStore();

  // Read once, at mount, and only ever used to fill the form in. Letting
  // it follow the queue would swap the fields out from under a parent's
  // fingers when a background retry happened to land.
  const [resumed] = useState(() => resumable(unsynced, typeId, eventId));

  // The queue's id if it has one, otherwise the caller's, and only then a
  // new one. A draft that was part way through being handed over comes
  // back under the id it was going out as, so however that race turned
  // out the server sees the same key.
  const [id] = useState(() => resumed?.eventId ?? eventId ?? newClientId());
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // The queue's own view of this add, which is the only authority on it.
  const entry = unsynced.find((candidate) => candidate.eventId === id) ?? null;
  const outcomeUnknown = entry?.outcomeUnknown ?? false;

  /**
   * Whether the queue has ever actually held this id.
   *
   * Not "has this screen tried to send", which is a different question
   * and the wrong one. Trying is not the same as landing: the write that
   * puts an entry in the queue can fail, and a screen that counted the
   * attempt would then decide, on the very next press, that its content
   * had been sent in the background -- and throw it away chasing an event
   * that was never created.
   *
   * It matters because it *is* still needed. The queue can send an entry
   * while this form is open, and a screen looking only at the present
   * would see nothing, call `addEvent`, and post amended content under an
   * id the server already holds; the server answers with what it stored
   * and the correction is gone while the screen says it was saved
   * (spec 6.1). So: ever held, observed rather than assumed.
   */
  const everQueued = useRef(resumed !== null);

  /**
   * Every route that reaches this screen with an entry already queued
   * takes it over at mount, so today the line above answers on its own
   * and nothing in the tests reaches this. It is here because the
   * question is "has the queue ever held this", and a screen that
   * acquired an entry after mounting would be a different answer -- not
   * as a second guard behind a first.
   */
  useEffect(() => {
    if (entry !== null) everQueued.current = true;
  }, [entry]);

  const submit = useCallback(
    async (input: NewEventInput): Promise<SubmitResult> => {
      // Gone, and it was ours: the queue held it and no longer does, so
      // it sent it while this screen was open. The server has the
      // original, and anything typed here is a change to a stored event
      // that has to go out as one.
      if (everQueued.current && entry === null) return { kind: 'gone', eventId: id };

      setBusy(true);
      setFailure(null);

      try {
        // While the outcome is in doubt the content is not the caller's to
        // choose, and it is not this screen's to supply either: only what
        // the queue stored can tell us what the server may already have.
        const event = outcomeUnknown
          ? await retryUnsynced(id)
          : entry !== null
            ? await correctUnsynced(id, input)
            : await addEvent(id, input);

        setBusy(false);
        // Null means it is waiting: the device was offline, so nothing was
        // sent and nothing is in doubt.
        return event === null ? { kind: 'queued' } : { kind: 'sent', event };
      } catch (error) {
        setBusy(false);
        if (error instanceof EntryGone) return { kind: 'gone', eventId: id };

        // Only for display. Whether this may be retried, corrected or
        // resent is decided by the entry, which the queue has just
        // updated -- so that is what is asked.
        setFailure(error);
        const stored = await getQueued(scope, id);
        return { kind: 'failed', inDoubt: stored?.outcomeUnknown ?? false };
      }
    },
    [addEvent, retryUnsynced, correctUnsynced, id, outcomeUnknown, entry, scope],
  );

  const retry = useCallback((): Promise<SubmitResult> => {
    if (!entry) return Promise.resolve<SubmitResult>({ kind: 'gone', eventId: id });
    return submit(entry.input);
  }, [entry, id, submit]);

  return { eventId: id, busy, outcomeUnknown, pending: resumed?.input ?? null, failure, submit, retry };
}
