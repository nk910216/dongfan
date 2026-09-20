import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import {
  deriveEventTimes, eventTypeName, getEventType, isWithinRange, metadataLabel,
  metadataOptionLabel, toDisplayed, toStored, valueLabel, zhTW,
} from '@dongfan/shared';
import type { EventIntent, MetadataField } from '@dongfan/shared';
import { EventIcon } from '../components/EventIcon.js';
import { useStore } from '../lib/store.js';

/**
 * Form for one event type.
 *
 * The intent switch is the visible half of a rule that has no other way to be
 * expressed: starting a timer and back-filling a finished event carry
 * identical fields, so the server cannot tell them apart unless the client
 * says which it meant (spec 3.5).
 */
export function EventForm(): React.JSX.Element {
  const { typeId = '' } = useParams();
  const navigate = useNavigate();
  const { addEvent, baby, summary } = useStore();
  const type = getEventType(typeId);

  // Captured once, then both displayed and submitted. Reading the clock again
  // at submit time would store a different instant from the one shown.
  const [startedAt] = useState(() => Date.now());

  const [intent, setIntent] = useState<EventIntent>(type?.timerEnabled ? 'start_timer' : 'record');
  const [displayValue, setDisplayValue] = useState(() => {
    // Feed amounts repeat, so the last one is a better starting point than an
    // empty box. It still has to be confirmed rather than submitted silently.
    if (!type?.value) return '';
    const last = summary.types.get(type.id)?.lastValue ?? null;
    return last === null || last === 1 ? '' : String(toDisplayed(last, type.value));
  });
  const [note, setNote] = useState('');
  const [metadata, setMetadata] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const startedAtLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('zh-TW', {
        timeZone: baby.timezone,
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(startedAt)),
    [startedAt, baby.timezone],
  );

  if (!type) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <p className="text-sm text-ink-muted">{zhTW.eventType.unknown}</p>
        <Link to="/add" className="text-sm text-accent">{zhTW.addEvent.cancel}</Link>
      </div>
    );
  }

  const isTimer = type.timerEnabled && intent === 'start_timer';

  const submit = (): void => {
    let value = 1;

    if (type.value) {
      const trimmed = displayValue.trim();
      if (trimmed === '') {
        if (type.valueRequired) {
          setError(zhTW.fieldError.REQUIRED);
          return;
        }
      } else {
        const parsed = Number(trimmed);
        if (Number.isNaN(parsed) || !isWithinRange(parsed, type.value)) {
          setError(
            zhTW.fieldError.OUT_OF_RANGE
              .replace('{min}', String(type.value.min))
              .replace('{max}', String(type.value.max)),
          );
          return;
        }
        value = toStored(parsed, type.value);
      }
    }

    for (const field of type.metadataFields ?? []) {
      if (field.required && !metadata[field.id]) {
        setError(zhTW.fieldError.REQUIRED);
        return;
      }
    }

    const times = deriveEventTimes(type, startedAt, intent, baby.timezone);
    addEvent({ typeId: type.id, intent, ...times, value, note, metadata });
    navigate('/');
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
                  className="flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors"
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

        <Field label={zhTW.addEvent.startedAt}>
          <div className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base">{startedAtLabel}</div>
        </Field>

        {type.hasRange ? (
          <Field label={zhTW.addEvent.endedAt}>
            <div className="rounded-xl border border-dashed border-line bg-surface/60 px-4 py-3.5 text-base text-ink-dim">
              {zhTW.addEvent.endedAtPlaceholder}
            </div>
          </Field>
        ) : null}

        {type.value ? (
          <Field label={`${valueLabel(type.id)} (${type.value.unit})`}>
            <input
              inputMode="decimal"
              value={displayValue}
              onChange={(e) => { setDisplayValue(e.target.value); setError(null); }}
              placeholder={`${type.value.min} – ${type.value.max}`}
              className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
            />
          </Field>
        ) : null}

        {(type.metadataFields ?? []).map((field) => (
          <MetadataInput
            key={field.id}
            field={field}
            color={type.color}
            value={metadata[field.id] ?? ''}
            onChange={(v) => { setMetadata((m) => ({ ...m, [field.id]: v })); setError(null); }}
          />
        ))}

        <Field label={zhTW.addEvent.note}>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={zhTW.addEvent.notePlaceholder}
            maxLength={1000}
            className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
          />
        </Field>

        {error ? <p className="mb-4 text-sm text-red-300">{error}</p> : null}
      </div>

      <div className="shrink-0 border-t border-line-soft px-4.5 pt-3 pb-6">
        <button
          type="button"
          onClick={submit}
          className="w-full rounded-2xl py-4 text-base font-bold text-ground"
          style={{ backgroundColor: type.color }}
        >
          {isTimer ? zhTW.addEvent.startTimer : zhTW.addEvent.save}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-4">
      <span className="mb-1.5 block text-xs tracking-wide text-ink-faint">{label}</span>
      {children}
    </div>
  );
}

function MetadataInput({
  field, color, value, onChange,
}: {
  field: MetadataField; color: string; value: string; onChange: (value: string) => void;
}): React.JSX.Element {
  if (field.kind === 'enum') {
    return (
      <Field label={metadataLabel(field.id)}>
        <div className="flex gap-2">
          {field.options.map((option) => {
            const selected = value === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => onChange(selected ? '' : option)}
                className="flex-1 rounded-xl border py-3 text-sm"
                style={
                  selected
                    ? { borderColor: color, borderWidth: 1.5, backgroundColor: `${color}22`, color }
                    : { borderColor: '#2E2921', backgroundColor: '#1C1915', color: '#C9C0B2' }
                }
              >
                {metadataOptionLabel(field.id, option)}
              </button>
            );
          })}
        </div>
      </Field>
    );
  }

  if (field.kind === 'number') {
    return (
      <Field label={metadataLabel(field.id)}>
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
        />
      </Field>
    );
  }

  return (
    <Field label={metadataLabel(field.id)}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={field.maxLength}
        className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
      />
    </Field>
  );
}
