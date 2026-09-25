import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { eventTypeName, getEventType, interpolate, zhTW } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import { ApiFailure, OfflineError, isOffline } from '../lib/api.js';
import { DateTimeField } from '../components/DateTimeField.js';
import { EventIcon } from '../components/EventIcon.js';
import { checkDraft, draftForValue } from '../components/EventFields.js';
import { ErrorLine, describeFailure } from '../components/FieldErrors.js';
import { Message } from '../components/Message.js';
import { formatClock, formatDuration } from '../lib/format.js';
import { useReturnTo } from '../lib/return-to.js';
import { draftFor, useStore } from '../lib/store.js';

/**
 * Confirming a timer that was stopped with no signal.
 *
 * The moment the button was pressed is already written down; this is where
 * it becomes a record. Spec 7.2 is explicit that it is not sent
 * automatically, and the reason is on this screen: between the press and
 * the connection returning, the other parent may have stopped the same
 * timer, or moved its start, and what to do about that is a question for a
 * person rather than a rule (spec 6.3).
 *
 * So the event is fetched fresh, every time, and what comes back is shown
 * beside what was pressed.
 */
export function ConfirmStop(): React.JSX.Element {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  // Back to the screen this was opened from, so a card on the timeline
  // behaves like the ones beside it whatever state it is in.
  const back = useReturnTo();
  const { baby, stopDrafts, findEvent, updateEvent, discardStop } = useStore();

  // Looked up once. Confirming removes it, and a screen that followed the
  // list would navigate away underneath its own submit.
  const [draft] = useState(() => draftFor(stopDrafts, eventId));

  const [event, setEvent] = useState<EventDto | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(draft?.endedAt ?? null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reloads, setReloads] = useState(0);

  const hasDraft = draft !== null;

  useEffect(() => {
    if (!hasDraft) return;
    let cancelled = false;
    setLoadError(null);

    // Confirming means reading what the server holds now, and with no
    // connection there is no way to do that. Said plainly rather than as a
    // failed request, because the parent needs to know the moment they
    // pressed is still safe -- it is the only thing here that cannot be
    // worked out again later (spec 7.2).
    if (isOffline()) {
      setLoadError(new OfflineError());
      return;
    }

    // Fresh, not the local copy. The local one is what this device knew
    // when it lost the connection, and the whole question here is what has
    // happened since (spec 7.2).
    findEvent(eventId, { fresh: true })
      .then((found) => {
        if (!cancelled) setEvent(found);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, findEvent, hasDraft, reloads]);

  // The connection returning is the one thing this screen is waiting for.
  useEffect(() => {
    const again = (): void => setReloads((n) => n + 1);
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, []);

  // Nothing to confirm: already dealt with, or a link followed too late.
  if (!draft) return <Navigate to={back} replace />;

  const type = event ? getEventType(event.typeId) : undefined;

  const submit = async (): Promise<void> => {
    if (!event || !type || endedAt === null) return;
    setFailure(null);

    const checked = checkDraft(
      type,
      {
        startedAt: event.startedAt,
        endedAt,
        displayValue: draftForValue(type.value ?? null, event.value),
        note: event.note,
        metadata: event.metadata,
      },
      'record',
      { now: Date.now(), timeZone: baby.timezone, birthDate: baby.birthDate },
    );
    if (!checked.ok) {
      setFailure(checked.message);
      return;
    }

    setBusy(true);
    try {
      // Only the end time. The version comes from what was just fetched,
      // and sending the other fields back would write this device's idea
      // of them over whatever the other parent changed (spec 6.3).
      await updateEvent(event.id, event.version, { endedAt: checked.endedAt });
      // Cleared here rather than by the update itself. An update only
      // answers this draft when it is *this* one -- a note corrected
      // elsewhere must leave the moment alone (spec 7.2).
      await discardStop(eventId);
      navigate(back);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
        // Somebody got there between the fetch and the submit. Fetch again
        // and let them look at it once more rather than retrying blindly.
        setFailure(error);
        setReloads((n) => n + 1);
        return;
      }
      setFailure(error);
    }
  };

  const discard = async (): Promise<void> => {
    await discardStop(eventId);
    navigate(back);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link to={back} aria-label={zhTW.a11y.back} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <div className="-ml-11 flex flex-1 items-center justify-center gap-2">
          {type ? <EventIcon icon={type.icon} color={type.color} size={18} /> : null}
          <span className="text-base font-medium">{zhTW.stopDraft.title}</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4">
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">{zhTW.stopDraft.intro}</p>

        {/* The instant the button was pressed, kept whatever happens to
            this screen. Shown as well as offered in the field, so that
            adjusting the field does not erase what it actually was. */}
        <p className="mb-4 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn-soft" data-testid="pressed-at">
          {zhTW.stopDraft.pressedAt} · {formatClock(draft.endedAt, baby.timezone)}
        </p>

        {loadError !== null ? (
          <>
            <p className="mb-4 text-sm text-ink-muted" data-testid="confirm-blocked">
              {loadError instanceof ApiFailure && loadError.status === 404
                ? zhTW.stopDraft.gone
                : zhTW.stopDraft.offline}
            </p>
            <p className="mb-4 text-xs text-ink-dim">{describeFailure(loadError)}</p>
          </>
        ) : null}

        {event && type ? (
          <>
            <p className="mb-3 text-[13px] text-ink-muted">
              {eventTypeName(event.typeId)} · {formatClock(event.startedAt, baby.timezone)}
              {endedAt !== null && endedAt >= event.startedAt
                ? ` · ${formatDuration(endedAt - event.startedAt)}`
                : ''}
            </p>

            {/* Two different things worth saying, and they are not the
                same: somebody edited this, versus somebody already ended
                it. The second one means confirming would overwrite their
                answer with this one. */}
            {event.endedAt !== null ? (
              <p className="mb-3 text-xs leading-relaxed text-amber-300/90" data-testid="already-ended">
                {interpolate(zhTW.stopDraft.alreadyEnded, {
                  time: formatClock(event.endedAt, baby.timezone),
                })}
              </p>
            ) : event.version !== draft.version ? (
              <p className="mb-3 text-xs leading-relaxed text-amber-300/90" data-testid="changed-since">
                {zhTW.stopDraft.changed}
              </p>
            ) : null}

            <DateTimeField
              label={zhTW.addEvent.endedAt}
              value={endedAt}
              timeZone={baby.timezone}
              testId="ended-at"
              onChange={(instant) => {
                setEndedAt(instant);
                setFailure(null);
              }}
            />
          </>
        ) : loadError === null ? (
          <Message text={zhTW.app.loading} />
        ) : null}

        <ErrorLine failure={failure} />

        {confirming ? (
          <div className="mb-6 rounded-2xl border border-line bg-surface p-4">
            <p className="mb-1 text-[15px] font-medium">{zhTW.stopDraft.discardTitle}</p>
            <p className="mb-3 text-xs leading-relaxed text-ink-faint">{zhTW.stopDraft.discardBody}</p>
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
                onClick={() => void discard()}
                data-testid="discard-confirm"
                className="min-h-11 flex-1 rounded-xl bg-red-400/90 text-sm font-bold text-ground"
              >
                {zhTW.stopDraft.discardYes}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            data-testid="discard"
            className="mb-6 min-h-11 w-full rounded-xl border border-line text-sm text-red-300"
          >
            {event?.endedAt != null ? zhTW.stopDraft.keepTheirs : zhTW.stopDraft.discard}
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-line-soft px-4.5 pt-3 pb-6">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || event === null || endedAt === null}
          data-testid="submit"
          className="min-h-11 w-full rounded-2xl bg-accent py-4 text-base font-bold text-ground disabled:opacity-60"
        >
          {busy ? zhTW.addEvent.saving : zhTW.stopDraft.confirm}
        </button>
      </div>
    </div>
  );
}
