import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { deriveEventTimes, eventTypeName, getEventType, zhTW } from '@dongfan/shared';
import type { EventIntent } from '@dongfan/shared';
import { EventIcon } from '../components/EventIcon.js';
import { EventFields, checkDraft, draftForValue } from '../components/EventFields.js';
import type { EventDraft } from '../components/EventFields.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { useCreateEvent } from '../lib/create-event.js';
import { typeSummary, useStore } from '../lib/store.js';

/**
 * Form for a new event of one type.
 *
 * The intent switch is the visible half of a rule that has no other way to
 * be expressed: starting a timer and writing up a finished event carry
 * identical fields, so the server cannot tell them apart unless the client
 * says which it meant (spec 3.5).
 */
export function EventForm(): React.JSX.Element {
  const { typeId = '' } = useParams();
  const navigate = useNavigate();
  const { baby, summary } = useStore();
  const create = useCreateEvent(typeId);
  const type = getEventType(typeId);

  const [intent, setIntent] = useState<EventIntent>(
    // A resumed add keeps the intent it was sent with, or a timer would
    // come back as a back-filled record and vice versa.
    create.pending?.intent ?? (type?.timerEnabled ? 'start_timer' : 'record'),
  );
  const [draft, setDraft] = useState<EventDraft>(() => {
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
      startedAt: type ? deriveEventTimes(type, Date.now(), 'record', baby.timezone).startedAt : Date.now(),
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
        <Link to="/add" className="text-sm text-accent">{zhTW.addEvent.cancel}</Link>
      </div>
    );
  }

  const isTimer = type.timerEnabled && intent === 'start_timer';

  const submit = async (): Promise<void> => {
    setLocalError(null);

    const checked = checkDraft(type, draft, intent, {
      now: Date.now(),
      timeZone: baby.timezone,
      birthDate: baby.birthDate,
    });
    if (!checked.ok) {
      setLocalError(checked.message);
      return;
    }

    const created = await create.submit({
      typeId: type.id,
      intent,
      startedAt: draft.startedAt,
      endedAt: checked.endedAt,
      value: checked.value,
      note: draft.note,
      metadata: draft.metadata,
    });
    if (created) navigate('/');
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link to="/add" aria-label={zhTW.addEvent.cancel} className="flex size-11 items-center justify-center text-ink-muted">
          <ChevronLeft size={22} />
        </Link>
        <div className="-ml-11 flex flex-1 items-center justify-center gap-2">
          <EventIcon icon={type.icon} color={type.color} size={18} />
          <span className="text-base font-medium">{eventTypeName(type.id)}</span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4.5 pt-4">
        {type.timerEnabled ? (
          <>
            <div className="mb-2 flex rounded-xl border border-line bg-surface p-0.75">
              {(['start_timer', 'record'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setIntent(option)}
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

        <fieldset disabled={create.outcomeUnknown} className="border-0 p-0">
          <EventFields
            type={type}
            draft={draft}
            timeZone={baby.timezone}
            showEnd={!isTimer}
            onChange={(next) => { setDraft(next); setLocalError(null); }}
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
