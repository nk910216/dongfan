import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { eventTypeName, getEventType, zhTW } from '@dongfan/shared';
import type { EventIntent } from '@dongfan/shared';
import { EventIcon } from '../components/EventIcon.js';
import { EventFields, checkDraft, draftForValue } from '../components/EventFields.js';
import type { EventDraft } from '../components/EventFields.js';
import { ErrorLine } from '../components/FieldErrors.js';
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
  const { addEvent, baby, summary } = useStore();
  const type = getEventType(typeId);

  const [intent, setIntent] = useState<EventIntent>(type?.timerEnabled ? 'start_timer' : 'record');
  const [draft, setDraft] = useState<EventDraft>(() => ({
    // Captured once, then both shown and submitted. Reading the clock again
    // at submit time would store a different instant from the one displayed.
    startedAt: Date.now(),
    endedAt: null,
    // Feed amounts repeat, so the last one is a better starting point than
    // an empty box. It still has to be confirmed rather than sent silently.
    displayValue: draftForValue(type?.value ?? null, typeSummary(summary, typeId)?.lastValue ?? null),
    note: '',
    metadata: {},
  }));
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

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
    setFailure(null);

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
      await addEvent({
        typeId: type.id,
        intent,
        startedAt: draft.startedAt,
        endedAt: checked.endedAt,
        value: checked.value,
        note: draft.note,
        metadata: draft.metadata,
      });
      navigate('/');
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
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

        <EventFields
          type={type}
          draft={draft}
          timeZone={baby.timezone}
          showEnd={!isTimer}
          onChange={(next) => { setDraft(next); setFailure(null); }}
        />

        <ErrorLine failure={failure} />
      </div>

      <div className="shrink-0 border-t border-line-soft px-4.5 pt-3 pb-6">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          data-testid="submit"
          className="min-h-11 w-full rounded-2xl py-4 text-base font-bold text-ground disabled:opacity-60"
          style={{ backgroundColor: type.color }}
        >
          {busy ? zhTW.addEvent.saving : isTimer ? zhTW.addEvent.startTimer : zhTW.addEvent.save}
        </button>
      </div>
    </div>
  );
}
