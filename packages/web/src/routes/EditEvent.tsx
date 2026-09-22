import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { eventTypeName, getEventType, zhTW } from '@dongfan/shared';
import type { EventDto, EventIntent } from '@dongfan/shared';
import { ApiFailure } from '../lib/api.js';
import { EventIcon } from '../components/EventIcon.js';
import { EventFields, checkDraft, draftForValue } from '../components/EventFields.js';
import type { EventDraft } from '../components/EventFields.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { Message } from '../components/Message.js';
import { clearForm, formKey, readForm, saveForm } from '../lib/form-draft.js';
import { useStore } from '../lib/store.js';

/**
 * Editing and deleting one event.
 *
 * Every write carries the version that was read, and a mismatch is not
 * merged: with two people using the app, a merge interface costs far more
 * than it saves, and being told plainly that someone else got there first
 * is enough (spec 6.3).
 */
export function EditEvent(): React.JSX.Element {
  const { eventId = '' } = useParams();
  const navigate = useNavigate();
  const { baby, scope, findEvent, updateEvent, removeEvent } = useStore();

  const [event, setEvent] = useState<EventDto | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  /**
   * The version every write from this screen carries.
   *
   * Normally the one that was just fetched. After a restored draft it is
   * the one those changes were made on top of, which is the point: the
   * fields on screen belong to that version, and handing the server a
   * newer number would let them overwrite whatever happened in between
   * without the conflict ever being reported (spec 6.3).
   */
  const [version, setVersion] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  const type = event ? getEventType(event.typeId) : undefined;

  // Same as the add form: a reload must not lose what is being typed
  // (spec 2.1). The event itself is re-fetched, so only the changes on top
  // of it are at stake -- which is all of what the parent did.
  const formId = formKey(scope, `edit:${eventId}`);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    // After a conflict the local copy is by definition the stale one, so
    // the reload has to come from the server. Handing back what we hold
    // would send the same version again and collect the same 409 (spec 6.3).
    findEvent(eventId, { fresh: reloads > 0 })
      .then((found) => {
        if (cancelled) return;
        setEvent(found);
        // What was being typed, if there is any -- but only on the first
        // load. A reload after a conflict is deliberate: the point of it
        // is to show what the other parent actually saved so this one can
        // decide again, and putting the stale draft back would hide the
        // very change they were told about (spec 6.3). The dialog says as
        // much before it happens.
        const held = reloads === 0 ? readForm(formId) : null;

        /**
         * A draft is only usable if it says which version it was written
         * against.
         *
         * One without it comes from a build that did not record one, and
         * there is no version it can safely be applied to: paired with
         * whatever the event looks like now, it puts its own idea of every
         * field over anything that has happened since, and the server
         * accepts it because the number it was handed is current
         * (spec 6.3). That is the failure this whole field exists to stop,
         * and it does not stop being that failure because the draft is
         * old.
         *
         * So it is dropped, and the stored event is shown instead. It
         * costs the typing in one draft, once, on the upgrade that
         * introduced the field -- against silently overwriting what the
         * other parent saved.
         */
        const saved = held?.baseVersion === undefined ? null : held;
        if (reloads > 0 || (held !== null && saved === null)) clearForm(formId);

        setDraft(saved?.draft ?? {
          startedAt: found.startedAt,
          endedAt: found.endedAt,
          displayValue: draftForValue(getEventType(found.typeId)?.value ?? null, found.value),
          note: found.note,
          metadata: { ...found.metadata },
        });
        // A restored draft keeps the version it was written against. If
        // somebody else has saved since, the server refuses it and the
        // dialog below asks what to do -- rather than the change going
        // through and taking theirs with it.
        setVersion(saved?.baseVersion ?? found.version);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [eventId, findEvent, reloads, formId]);

  if (loadError !== null) return <Message text={zhTW.error.NOT_FOUND} />;
  if (!event || !draft || !type || version === null) return <Message text={zhTW.app.loading} />;

  const save = async (): Promise<void> => {
    setFailure(null);

    // A running timer is still running unless an end time was supplied, so
    // the intent it is checked against has to match what the server will
    // decide from the same two facts (spec 3.5).
    const intent = intentOf(event, draft);
    const checked = checkDraft(type, draft, intent, {
      now: Date.now(),
      timeZone: baby.timezone,
      birthDate: baby.birthDate,
    });
    if (!checked.ok) {
      setFailure(checked.message);
      return;
    }

    setBusy(true);
    try {
      await updateEvent(event.id, version, {
        startedAt: draft.startedAt,
        endedAt: checked.endedAt,
        ...(checked.value === undefined ? {} : { value: checked.value }),
        note: draft.note,
        metadata: draft.metadata,
      });
      clearForm(formId);
      navigate('/');
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') setConflict(true);
      else setFailure(error);
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await removeEvent(event.id, version);
      clearForm(formId);
      navigate('/');
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') setConflict(true);
      else setFailure(error);
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link to="/" aria-label={zhTW.addEvent.cancel} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <div className="-ml-11 flex flex-1 items-center justify-center gap-2">
          <EventIcon icon={type.icon} color={type.color} size={18} />
          <span className="text-base font-medium">{eventTypeName(type.id)}</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4">
        <p className="mb-4 text-xs text-ink-dim">{zhTW.event.edit}</p>

        <EventFields
          type={type}
          draft={draft}
          timeZone={baby.timezone}
          // A running timer has no end time yet, but supplying one here is
          // exactly how it is stopped, so the field stays available.
          showEnd
          onChange={(next) => {
            setDraft(next);
            setFailure(null);
            // Written down with the version it is a change to, because
            // without that it cannot be told apart from a change to
            // whatever the event looks like later.
            saveForm(formId, intentOf(event, next), next, { baseVersion: version });
          }}
        />

        <ErrorLine failure={failure} />

        {confirming ? (
          <div className="mb-6 rounded-2xl border border-line bg-surface p-4">
            <p className="mb-3 text-sm text-ink-muted">{zhTW.event.deleteConfirm}</p>
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
                disabled={busy}
                onClick={() => void remove()}
                className="min-h-11 flex-1 rounded-xl bg-red-400/90 text-sm font-bold text-ground disabled:opacity-60"
              >
                {zhTW.event.deleteConfirmYes}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mb-6 min-h-11 w-full rounded-xl border border-line text-sm text-red-300"
          >
            {zhTW.addEvent.delete}
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-line-soft px-4.5 pt-3 pb-6">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          data-testid="submit"
          className="min-h-11 w-full rounded-2xl py-4 text-base font-bold text-ground disabled:opacity-60"
          style={{ backgroundColor: type.color }}
        >
          {busy ? zhTW.addEvent.saving : zhTW.addEvent.save}
        </button>
      </div>

      {conflict ? (
        <ConflictDialog
          onReload={() => {
            setConflict(false);
            setBusy(false);
            setReloads((n) => n + 1);
          }}
          onCancel={() => navigate('/')}
        />
      ) : null}
    </div>
  );
}

/** The one rule for reading an intent off an event and a draft (spec 3.5). */
function intentOf(event: EventDto, draft: EventDraft): EventIntent {
  return event.active && draft.endedAt === null ? 'start_timer' : 'record';
}

/**
 * What a parent sees when the other one saved first.
 *
 * It says the change was not stored, because it genuinely was not: the
 * guard means the transaction touched nothing at all (spec 4.3).
 */
function ConflictDialog({ onReload, onCancel }: { onReload: () => void; onCancel: () => void }): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-6" role="dialog" aria-modal="true">
      <div className="w-full rounded-2xl border border-line bg-surface-raised p-4">
        <p className="mb-1.5 text-[15px] font-medium">{zhTW.error.VERSION_CONFLICT}</p>
        <p className="mb-4 text-xs leading-relaxed text-ink-faint">{zhTW.conflict.body}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 flex-1 rounded-xl border border-line text-sm text-ink-muted"
          >
            {zhTW.addEvent.cancel}
          </button>
          <button
            type="button"
            onClick={onReload}
            className="min-h-11 flex-1 rounded-xl bg-accent text-sm font-bold text-ground"
          >
            {zhTW.conflict.reload}
          </button>
        </div>
      </div>
    </div>
  );
}
