import { useEffect, useState } from 'react';
import { formatClock } from '../lib/format.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import {
  eventTypeName, getEventType, metadataOptionLabel, valueLabel, zhTW,
} from '@dongfan/shared';
import type { EventDto, EventIntent, EventTypeConfig } from '@dongfan/shared';
import { ApiFailure } from '../lib/api.js';
import { EventIcon } from '../components/EventIcon.js';
import { EventFields, checkDraft, draftForValue } from '../components/EventFields.js';
import type { EventDraft } from '../components/EventFields.js';
import type { SavedForm } from '../lib/form-draft.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { Message } from '../components/Message.js';
import { clearForm, formKey, moveForm, readForm, saveForm } from '../lib/form-draft.js';
import { useReturnTo } from '../lib/return-to.js';
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
  // Back to the screen this was opened from -- the calendar, on the day
  // being read -- rather than always to the home screen.
  const back = useReturnTo();
  const { baby, scope, findEvent, updateEvent, removeEvent, tags, createTag } = useStore();

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
  /**
   * A draft from a build that did not record what version it was written
   * on, held to be read rather than applied. See below.
   */
  const [stale, setStale] = useState<SavedForm | null>(null);

  const type = event ? getEventType(event.typeId) : undefined;

  // Same as the add form: a reload must not lose what is being typed
  // (spec 2.1). The event itself is re-fetched, so only the changes on top
  // of it are at stake -- which is all of what the parent did.
  const formId = formKey(scope, `edit:${eventId}`);

  /**
   * Where a draft that cannot be applied is parked.
   *
   * Its own key, not the live form's. They are two different things --
   * one is being typed, the other is being read -- and sharing a key
   * means every keystroke overwrites what is on display, and dismissing
   * what is on display deletes what is being typed.
   */
  const staleId = formKey(scope, `stale-edit:${eventId}`);

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
        // Read whatever the last visit parked, whether or not this is a
        // reload: a reload after a conflict replaces what is being typed,
        // and says nothing about a draft still waiting to be read.
        const parked = readForm(staleId);
        if (parked) setStale(parked);

        const held = reloads === 0 ? readForm(formId) : null;

        /**
         * A draft can only be applied if it says which version it was
         * written against.
         *
         * One without it comes from a build that did not record one, and
         * there is no version it is safe to apply it to: paired with
         * whatever the event looks like now, it puts its own idea of every
         * field over anything that has happened since, and the server
         * accepts it because the number it was handed is current
         * (spec 6.3). That is the failure the field exists to stop, and it
         * does not stop being that failure because the draft is old.
         *
         * So it is not applied -- and not thrown away either, which would
         * be the other half of spec 2.1 broken to fix the first. It is
         * shown, unapplied, for whoever wrote it to take what they want
         * from and dismiss.
         */
        const usable = held?.baseVersion !== undefined ? held : null;
        if (held !== null && usable === null) {
          // Out of the live form's way first, so that typing below
          // neither overwrites it nor is thrown away with it.
          moveForm(formId, staleId);
          setStale(held);
        }
        const saved = usable;
        if (reloads > 0) clearForm(formId);

        // A draft written before tags were a field has none of its own, so
        // it takes the event's: the parent never chose to remove them, and
        // applying an absent field as an empty list would silently strip
        // every tag off the record (spec 2.1).
        setDraft(saved?.draft
          // An existing record: a draft from before tags has no opinion about
          // them, so the record keeps the ones it has. Only a list this build
          // wrote -- empty included -- is somebody's choice.
          ? { ...saved.draft, tagIds: saved.draft.tagIds ?? [...found.tagIds] }
          : {
            startedAt: found.startedAt,
            endedAt: found.endedAt,
            displayValue: draftForValue(getEventType(found.typeId)?.value ?? null, found.value),
            note: found.note,
            metadata: { ...found.metadata },
            tagIds: [...found.tagIds],
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
  }, [eventId, findEvent, reloads, formId, staleId]);

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
        // Sent with the version the screen was opened on. If somebody else
        // has saved since, the server refuses the whole update -- the body
        // and the tags together -- and nothing here is applied over theirs
        // (spec 6.3, 4.3).
        tagIds: draft.tagIds,
      });
      clearForm(formId);
      navigate(back);
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
      navigate(back);
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
        <Link to={back} aria-label={zhTW.addEvent.cancel} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <div className="flex flex-1 items-center justify-center gap-2">
          <EventIcon icon={type.icon} color={type.color} size={18} />
          <span className="text-base font-medium">{eventTypeName(type.id)}</span>
        </div>
        {/* As wide as the back button, so the title is centred without
            overlapping it. A negative margin did the centring before, and
            the title then lay over the button and took most taps meant for
            it -- only the icon's corner still worked. Found on a phone. */}
        <span className="size-11 shrink-0" aria-hidden />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4">
        <p className="mb-4 text-xs text-ink-dim">{zhTW.event.edit}</p>

        {stale ? (
          <StaleDraft
            saved={stale}
            type={type}
            timeZone={baby.timezone}
            // Only what is on display. What is being typed below lives
            // under its own key and is none of this button's business.
            onDismiss={() => {
              clearForm(staleId);
              setStale(null);
            }}
          />
        ) : null}

        <EventFields
          type={type}
          draft={draft}
          timeZone={baby.timezone}
          tags={tags}
          onCreateTag={createTag}
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
          onCancel={() => navigate(back)}
        />
      ) : null}
    </div>
  );
}

/**
 * A draft that cannot be applied, laid out to be read.
 *
 * Deliberately not fields. Anything typeable here would be a second form
 * competing with the real one, and anything with a "use this" button
 * would be the overwrite this is avoiding. It is what they wrote, and a
 * way to say they are done with it.
 */
function StaleDraft({ saved, type, timeZone, onDismiss }: {
  saved: SavedForm;
  type: EventTypeConfig;
  timeZone: string;
  onDismiss: () => void;
}): React.JSX.Element {
  const lines: string[] = [];
  const { draft } = saved;

  lines.push(`${zhTW.addEvent.startedAt}: ${formatClock(draft.startedAt, timeZone)}`);
  if (draft.endedAt !== null) {
    lines.push(`${zhTW.addEvent.endedAt}: ${formatClock(draft.endedAt, timeZone)}`);
  }
  if (type.value && draft.displayValue.trim() !== '') {
    lines.push(`${valueLabel(type.id)}: ${draft.displayValue} ${type.value.unit}`);
  }
  for (const [key, value] of Object.entries(draft.metadata)) {
    if (value !== '') lines.push(metadataOptionLabel(key, value));
  }
  if (draft.note !== '') lines.push(`${zhTW.addEvent.note}: ${draft.note}`);

  return (
    <div className="mb-5 rounded-2xl border border-warn/50 bg-warn/10 p-3.5" data-testid="stale-draft">
      <p className="text-[13px] font-medium text-warn-soft">{zhTW.staleDraft.title}</p>
      <p className="mt-1 mb-2.5 text-[11px] leading-relaxed text-ink-muted">{zhTW.staleDraft.body}</p>
      <ul className="mb-3 flex flex-col gap-0.5">
        {lines.length === 0 ? (
          <li className="text-[13px] text-ink-faint">{zhTW.staleDraft.empty}</li>
        ) : (
          lines.map((line) => (
            <li key={line} className="text-[13px] break-words text-ink-muted">{line}</li>
          ))
        )}
      </ul>
      <button
        type="button"
        onClick={onDismiss}
        data-testid="stale-draft-dismiss"
        className="min-h-11 text-[12px] text-ink-dim"
      >
        {zhTW.staleDraft.dismiss}
      </button>
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
