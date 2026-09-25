import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { deriveEventTimes, eventTypeName, getEventType, interpolate, zhTW } from '@dongfan/shared';
import type { EventIntent } from '@dongfan/shared';
import { EventIcon } from '../components/EventIcon.js';
import { EventFields, checkDraft, draftForValue } from '../components/EventFields.js';
import type { EventDraft } from '../components/EventFields.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { useCreateEvent } from '../lib/create-event.js';
import type { SubmitResult } from '../lib/create-event.js';
import { askedDay, dayView, daySuffix, startFor } from '../lib/dated-add.js';
import { clearForm, formKey, readForm, saveForm } from '../lib/form-draft.js';
import { typeSummary, useStore } from '../lib/store.js';

/**
 * Form for a new event of one type.
 *
 * The intent switch is the visible half of a rule that has no other way to
 * be expressed: starting a timer and writing up a finished event carry
 * identical fields, so the server cannot tell them apart unless the client
 * says which it meant (spec 3.5).
 *
 * The same form serves "record something new" and "correct the one that
 * would not send". The failure list passes the entry it wants by props;
 * everything else comes in by route, and neither knows about the other.
 */
export function EventForm({ typeId: given, entryId }: {
  typeId?: string;
  entryId?: string;
} = {}): React.JSX.Element {
  const params = useParams();
  const typeId = given ?? params['typeId'] ?? '';
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { baby, scope, summary } = useStore();
  const type = getEventType(typeId);

  /**
   * The day this add was started from, when it was not today's screen.
   *
   * A correction being resent is never dated: it carries the content the
   * queue already holds, and the day it was for was decided when it was
   * first written (spec 6.1).
   */
  const day = entryId === undefined ? askedDay(search.toString()) : null;

  // Where what is being typed is kept, so that a reload does not throw it
  // away. Named by the account, the type, and which entry it is correcting,
  // because all three can have a form open at once (spec 2.1).
  //
  // The day is part of the name. Without it, a half-typed feed for the 18th
  // would be offered back on the 19th's form, holding the 18th's instant
  // while the screen said the 19th -- and the wrong one of those two would
  // be the one that got saved.
  const formId = formKey(scope, `add:${typeId}:${entryId ?? ''}${day === null ? '' : `:${day}`}`);

  /**
   * Read once, at mount, and already settled.
   *
   * Anything whose content reached the queue or the server has been
   * dropped by `reconcileForms` before this screen existed, so whatever
   * is here is still a draft. If it was part way through being handed
   * over it keeps the id it was going out as, and this screen carries on
   * under that id rather than inventing a new one -- which is what stops
   * the same feed becoming two records (spec 3.8).
   */
  const [saved] = useState(() => readForm(formId));

  const create = useCreateEvent(typeId, entryId ?? saved?.eventId);

  // Not offered while the outcome is unknown: the content then belongs to
  // the queue, and a half-typed correction must not be able to stand in
  // for what was actually sent (spec 6.1).
  const restored = create.outcomeUnknown ? null : saved;

  const [intent, setIntent] = useState<EventIntent>(
    // A resumed add keeps the intent it was sent with, or a timer would
    // come back as a back-filled record and vice versa.
    restored?.intent ??
      create.pending?.intent ??
      // Writing up an earlier day is never starting a timer. Saved as one
      // it would store a sleep that began four days ago and is still
      // running: instantly past the 24-hour limit, so the stop button
      // turns into the correction form, while holding the only
      // `active = 1` slot its type has -- so tonight's sleep cannot be
      // started either (spec 3.5, 7.2).
      (type?.timerEnabled && day === null ? 'start_timer' : 'record'),
  );
  const [draft, setDraft] = useState<EventDraft>(() => {
    // What was being typed when the page went away wins over everything
    // below: it is the most recent thing the parent did, and the whole
    // reason it was written down.
    if (restored) return restored.draft;

    // An add whose result is unknown comes back as it was sent, not as an
    // empty form: the screen has to show what is actually in doubt, and
    // nothing new can be started until it is settled (spec 6.1).
    const resumed = create.pending;
    if (resumed) {
      return {
        startedAt: resumed.startedAt,
        endedAt: resumed.endedAt,
        displayValue: draftForValue(type?.value ?? null, resumed.value ?? null),
        note: resumed.note,
        metadata: { ...resumed.metadata },
      };
    }

    return {
      // Captured once, then both shown and submitted. Reading the clock
      // again at submit time would store a different instant from the one
      // displayed.
      //
      // Through the shared helper, so an all-day event starts at local
      // midnight here as well as in the database. Sending the raw clock and
      // letting the server pin it works, but then the form is showing one
      // day's date while holding another day's instant (spec 3.9).
      // `startFor` is the clock for today and midday for any earlier day;
      // the reasoning is in dated-add.ts.
      startedAt: (() => {
        const from = startFor(day, baby.timezone, Date.now());
        return type ? deriveEventTimes(type, from, 'record', baby.timezone).startedAt : from;
      })(),
      endedAt: null,
      // Feed amounts repeat, so the last one is a better starting point
      // than an empty box. It still has to be confirmed rather than sent
      // silently.
      displayValue: draftForValue(type?.value ?? null, typeSummary(summary, typeId)?.lastValue ?? null),
      note: '',
      metadata: {},
    };
  });
  const [localError, setLocalError] = useState<string | null>(null);

  if (!type) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <p className="text-sm text-ink-muted">{zhTW.eventType.unknown}</p>
        <Link to={`/add${daySuffix(day)}`} className="text-sm text-accent">{zhTW.addEvent.cancel}</Link>
      </div>
    );
  }

  const isTimer = type.timerEnabled && intent === 'start_timer';

  /**
   * Where to go once the queue has answered.
   *
   * Waiting in the queue counts as done: the record is written down and
   * the parent has nothing left to do about it. Only a refusal keeps them
   * here, because only a refusal is something they can act on.
   */
  const finish = (result: SubmitResult): void => {
    if (result.kind === 'failed') return;
    // It is a record now, or an entry in the queue. Either way what was
    // typed here has become something durable and is no longer a draft.
    clearForm(formId);
    // The queue sent the original while this screen was open, so what is
    // typed here is now an edit to a stored event and has to carry a
    // version. That is the edit screen's job (spec 6.3).
    if (result.kind === 'gone') {
      navigate(`/event/${result.eventId}`);
      return;
    }
    // Back to the day the calendar was showing, whatever time was
    // finally entered. Spec 7.3 is explicit: not today.
    navigate(day === null ? '/' : dayView(day, baby.timezone, Date.now()));
  };

  const submit = async (): Promise<void> => {
    setLocalError(null);

    // A resend carries what the queue holds, so the draft is not what is
    // being checked and must not be able to block it. Frozen fields plus a
    // draft that no longer passes would leave no way forward and no way
    // back (spec 6.1).
    if (create.outcomeUnknown) {
      saveForm(formId, intent, draft, { eventId: create.eventId });
      finish(await create.retry());
      return;
    }

    const checked = checkDraft(type, draft, intent, {
      now: Date.now(),
      timeZone: baby.timezone,
      birthDate: baby.birthDate,
    });
    if (!checked.ok) {
      setLocalError(checked.message);
      return;
    }

    // Stamped before it goes, not after it comes back. A reload while the
    // request is still in the air would otherwise leave a draft that
    // looks untouched beside an entry the queue is already sending.
    saveForm(formId, intent, draft, { eventId: create.eventId });

    finish(await create.submit({
      typeId: type.id,
      intent,
      startedAt: draft.startedAt,
      endedAt: checked.endedAt,
      value: checked.value,
      note: draft.note,
      metadata: draft.metadata,
    }));
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link to={`/add${daySuffix(day)}`} aria-label={zhTW.addEvent.cancel} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <div className="-ml-11 flex flex-1 items-center justify-center gap-2">
          <EventIcon icon={type.icon} color={type.color} size={18} />
          <span className="text-base font-medium">{eventTypeName(type.id)}</span>
        </div>
      </header>

      {/* A form for the 18th looks exactly like a form for now. Saying so
          is what stops a record being filed under a day nobody chose --
          and the time below starts at midday rather than at the current
          clock for the same reason (see dated-add.ts). */}
      {day !== null ? (
        <p
          className="shrink-0 border-b border-line-soft bg-surface px-4 py-2 text-center text-xs text-accent"
          data-testid="adding-on"
        >
          {interpolate(zhTW.addEvent.onDate, { date: day })}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4">
        {type.timerEnabled ? (
          <>
            <div className="mb-2 flex rounded-xl border border-line bg-surface p-0.75">
              {(['start_timer', 'record'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setIntent(option);
                    saveForm(formId, option, draft);
                  }}
                  className="min-h-11 flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors"
                  style={
                    intent === option
                      ? { backgroundColor: type.color, color: '#13110E', fontWeight: 700 }
                      : { color: '#A89F92' }
                  }
                >
                  {option === 'start_timer' ? zhTW.addEvent.startTimer : zhTW.addEvent.record}
                </button>
              ))}
            </div>
            <p className="mb-5 text-[11px] leading-relaxed text-ink-dim">{zhTW.addEvent.intentHint}</p>
          </>
        ) : null}

        {/* Frozen from the moment the request leaves, not from the moment
            it fails: an amount changed while one was in flight would be
            frozen in place when the reply was lost, showing neither what
            was sent nor what gets resent. */}
        <fieldset disabled={create.busy || create.outcomeUnknown} className="border-0 p-0">
          <EventFields
            type={type}
            draft={draft}
            timeZone={baby.timezone}
            showEnd={!isTimer}
            // Written down as it is typed. Saving on the way out would
            // miss the reload this exists for: the browser reclaiming a
            // background tab does not ask first (spec 2.1).
            onChange={(next) => { setDraft(next); setLocalError(null); saveForm(formId, intent, next); }}
          />
        </fieldset>

        {/* Frozen on purpose. Changing the content now would send a
            correction under an id the server may already hold, and the
            server would answer with what it already has (spec 6.1). */}
        {create.outcomeUnknown ? (
          <p className="mb-4 text-xs leading-relaxed text-amber-300/90" data-testid="outcome-unknown">
            {zhTW.addEvent.outcomeUnknown}
          </p>
        ) : null}

        <ErrorLine failure={localError ?? create.failure} />
      </div>

      <div className="shrink-0 border-t border-line-soft px-4.5 pt-3 pb-6">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={create.busy}
          data-testid="submit"
          className="min-h-11 w-full rounded-2xl py-4 text-base font-bold text-ground disabled:opacity-60"
          style={{ backgroundColor: type.color }}
        >
          {create.busy
            ? zhTW.addEvent.saving
            : create.outcomeUnknown
              ? zhTW.addEvent.retry
              : isTimer ? zhTW.addEvent.startTimer : zhTW.addEvent.save}
        </button>
      </div>
    </div>
  );
}
