import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { errorMessage, eventTypeName, getEventType, interpolate, zhTW } from '@dongfan/shared';
import type { QueuedCreate } from '../lib/db.js';
import { EventIconBadge, FALLBACK_COLOR } from '../components/EventIcon.js';
import { describeQueued } from '../components/EventRow.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { EventForm } from './EventForm.js';
import { linkBack, useReturnTo } from '../lib/return-to.js';
import { useStore } from '../lib/store.js';

/**
 * Everything this device is still holding.
 *
 * Spec 6.1 asks for this in as many words: telling a parent that four
 * records have not been sent, without giving them any way to look at those
 * records or do anything about them, would be the same as not telling
 * them. Each entry can be read, sent again, corrected and sent again, or
 * given up on.
 *
 * "Give up" is the one with a trap in it. It stops this phone trying; it
 * says nothing about whether the server has the event. Where the outcome
 * was never known, it may well be stored, so the copy must not use the
 * word deleted (spec 6.1).
 */
export function Unsynced(): React.JSX.Element {
  const { unsynced } = useStore();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header title={zhTW.unsynced.title} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-8">
        {unsynced.length === 0 ? (
          <p className="rounded-2xl border border-line-soft bg-surface px-4 py-10 text-center text-sm text-ink-muted">
            {zhTW.unsynced.empty}
          </p>
        ) : (
          <>
            {/* iOS clears script-writable storage for a site that has not
                been opened for seven days unless it is on the home screen,
                and these entries go with it (spec 9.6). */}
            <p className="mb-3 text-[11px] leading-relaxed text-ink-dim">{zhTW.unsynced.hint}</p>
            {unsynced.map((entry) => <Row key={entry.eventId} entry={entry} />)}
          </>
        )}
      </div>
    </div>
  );
}

function Header({ title }: { title: string }): React.JSX.Element {
  // Back to wherever this was opened from. Reached from the home screen's
  // strip that is home; reached from a card on the timeline it is the day
  // being read, so a queued record behaves like the ones beside it.
  const back = useReturnTo();

  return (
    <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
      <Link to={back} aria-label={zhTW.a11y.back} className="flex size-11 items-center justify-center text-ink-muted">
        <ChevronLeft size={22} />
      </Link>
      <span className="flex-1 text-center text-base font-medium">{title}</span>
      {/* As wide as the back button, so the title is centred without
          overlapping it. A negative margin did the centring before, and
          the title then lay over the button and took most taps meant for
          it -- only the icon's corner still worked. Found on a phone. */}
      <span className="size-11 shrink-0" aria-hidden />
    </header>
  );
}

/** A one-line description of what is in an entry, so it can be recognised. */
function Row({ entry }: { entry: QueuedCreate }): React.JSX.Element {
  const { baby, retryUnsynced, abandonUnsynced } = useStore();
  // Handed on, so correcting a record does not lose the day it was opened
  // from -- which is the one place the chain used to break.
  const back = useReturnTo();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const type = getEventType(entry.input.typeId);
  const color = type?.color ?? FALLBACK_COLOR;

  const state = entry.outcomeUnknown
    ? zhTW.unsynced.unknown
    : entry.state === 'failed'
      ? zhTW.unsynced.failed
      : entry.attempts === 0
        ? zhTW.unsynced.queued
        : zhTW.unsynced.waiting;

  const retry = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await retryUnsynced(entry.eventId);
    } catch (error) {
      // Shown because a person asked for this one by hand. The queue's own
      // attempts stay silent and only move the count, or a phone on a bad
      // connection would interrupt somebody who is not even using it
      // (spec 7.11).
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mb-2.5 rounded-2xl border border-line bg-surface p-3"
      data-testid={`unsynced-${entry.eventId}`}
    >
      <div className="flex items-center gap-2.5">
        <EventIconBadge icon={type?.icon ?? 'circle-ellipsis'} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[15px] font-medium">{eventTypeName(entry.input.typeId)}</span>
            <span
              className="rounded border px-1.5 py-px text-[10px]"
              style={{ color, borderColor: `${color}66` }}
              data-testid="unsynced-state"
            >
              {state}
            </span>
          </div>
          <div className="mt-px truncate text-xs text-ink-faint">
            {describeQueued(entry, baby.timezone)}
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-ink-dim">
        {entry.attempts > 0 ? (
          <span>{interpolate(zhTW.unsynced.attempts, { attempts: entry.attempts })}</span>
        ) : null}
        {entry.lastCode !== null ? (
          <span>
            {interpolate(zhTW.unsynced.lastResponse, { message: errorMessage(entry.lastCode) })}
          </span>
        ) : null}
      </div>

      {/* Resend the original first, and only then correct it. Amended
          content under an id the server may already hold comes back as the
          stored event, and the correction is gone without a trace
          (spec 6.1). */}
      {entry.outcomeUnknown ? (
        <p className="mt-2 text-xs leading-relaxed text-amber-300/90" data-testid="unsynced-unknown">
          {zhTW.unsynced.unknownHint}
        </p>
      ) : null}

      <ErrorLine failure={failure} />

      {confirming ? (
        <div className="mt-2 rounded-xl border border-line bg-surface-raised p-3">
          <p className="mb-1 text-[13px] font-medium">{zhTW.unsynced.abandonTitle}</p>
          <p className="mb-3 text-xs leading-relaxed text-ink-faint">{zhTW.unsynced.abandonBody}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-11 flex-1 rounded-xl border border-line text-sm text-ink-muted"
            >
              {zhTW.addEvent.cancel}
            </button>
            <button
              type="button"
              onClick={() => void abandonUnsynced(entry.eventId)}
              data-testid="abandon-confirm"
              className="min-h-11 flex-1 rounded-xl bg-red-400/90 text-sm font-bold text-ground"
            >
              {zhTW.unsynced.abandonYes}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void retry()}
            data-testid="unsynced-retry"
            className="min-h-11 flex-1 rounded-xl text-sm font-bold text-ground disabled:opacity-60"
            style={{ backgroundColor: color }}
          >
            {zhTW.unsynced.retry}
          </button>
          {entry.outcomeUnknown ? null : (
            <Link
              to={linkBack(`/unsynced/${entry.eventId}`, back)}
              data-testid="unsynced-correct"
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl border border-line text-sm text-ink-muted"
            >
              {zhTW.unsynced.correct}
            </Link>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            data-testid="unsynced-abandon"
            className="min-h-11 flex-1 rounded-xl border border-line text-sm text-red-300"
          >
            {zhTW.unsynced.abandon}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The form again, pointed at one entry that is waiting.
 *
 * The entry decides the type, because it is the entry being corrected and
 * not a new record of whatever type the URL happened to say.
 */
export function CorrectUnsynced(): React.JSX.Element {
  const { eventId = '' } = useParams();
  const { unsynced } = useStore();
  const back = useReturnTo();

  /**
   * Looked up once, at mount.
   *
   * If the queue sends the entry while this screen is open, the screen
   * stays where it is. Somebody is typing a correction into it, and
   * replacing the page underneath them would throw that away without a
   * word. What has changed is where the correction has to go, and saying
   * so is the submit's job -- it knows this form had an entry, finds it
   * gone, and sends the parent to the edit screen rather than posting a
   * creation the server would answer with the record it already has
   * (spec 6.1, 6.3).
   */
  const [entry] = useState(() => unsynced.find((candidate) => candidate.eventId === eventId) ?? null);

  // Never here in the first place: the link was followed after it had
  // already gone.
  if (!entry) return <Navigate to={linkBack(`/event/${eventId}`, back)} replace />;

  return <EventForm typeId={entry.input.typeId} entryId={entry.eventId} />;
}
