import {
  fieldErrorMessage, metadataLabel, metadataOptionLabel, toDisplayed, toStored,
  valueLabel, validateEvent, zhTW,
} from '@dongfan/shared';
import type {
  EventIntent, EventTypeConfig, FieldError, MetadataField, ValueSpec,
} from '@dongfan/shared';
import { DateTimeField } from './DateTimeField.js';

/**
 * The inputs for one event, shared by the add and edit screens.
 *
 * Both screens render the same fields from the same config, so a type that
 * gains a metadata field gains it in both places at once. Writing the form
 * twice is how one of them quietly stops matching the other (spec 3.6).
 */

export type EventDraft = {
  startedAt: number;
  endedAt: number | null;
  /** What the parent typed, in display units. Converted on submit. */
  displayValue: string;
  note: string;
  metadata: Record<string, string>;
};

export function draftForValue(spec: ValueSpec | null, stored: number | null): string {
  if (spec === null || stored === null) return '';
  return String(toDisplayed(stored, spec));
}

export type DraftResult =
  | { ok: true; value: number | undefined; endedAt: number | null }
  | { ok: false; message: string };

/**
 * Checks a draft before it is sent.
 *
 * The same function the handler uses, so the form cannot accept something
 * the server refuses, or refuse something it would have taken. Reported
 * locally because a parent should not have to wait for a round trip to be
 * told the amount is out of range.
 */
export function checkDraft(
  type: EventTypeConfig,
  draft: EventDraft,
  intent: EventIntent,
  context: { now: number; timeZone: string; birthDate: string },
): DraftResult {
  let value: number | undefined;

  if (type.value) {
    const typed = draft.displayValue.trim();
    if (typed !== '') {
      const parsed = Number(typed);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: fieldErrorMessage({ field: 'value', code: 'INVALID_FORMAT', params: {} }) };
      }
      value = toStored(parsed, type.value);
    }
  }

  const endedAt = type.hasRange && intent === 'record' ? draft.endedAt : null;

  const errors: FieldError[] = validateEvent(
    type,
    { intent, startedAt: draft.startedAt, endedAt, value, note: draft.note, metadata: draft.metadata },
    context,
  );

  const first = errors[0];
  if (first) return { ok: false, message: fieldErrorMessage(first) };

  return { ok: true, value, endedAt };
}

export function EventFields({
  type, draft, timeZone, showEnd, onChange,
}: {
  type: EventTypeConfig;
  draft: EventDraft;
  timeZone: string;
  /** False while a timer is running: its end time is not a field yet. */
  showEnd: boolean;
  onChange: (next: EventDraft) => void;
}): React.JSX.Element {
  const patch = (part: Partial<EventDraft>): void => onChange({ ...draft, ...part });

  return (
    <>
      {/* An all-day event keeps the same control: whatever hour is picked,
          the server pins it to local midnight, so the two cannot disagree
          about which day it lands on (spec 3.9). */}
      <DateTimeField
        label={zhTW.addEvent.startedAt}
        value={draft.startedAt}
        timeZone={timeZone}
        testId="started-at"
        onChange={(startedAt) => patch({ startedAt })}
      />

      {type.hasRange && showEnd ? (
        <DateTimeField
          label={zhTW.addEvent.endedAt}
          value={draft.endedAt}
          timeZone={timeZone}
          testId="ended-at"
          onChange={(endedAt) => patch({ endedAt })}
          onClear={() => patch({ endedAt: null })}
        />
      ) : null}

      {type.value ? (
        <Field label={`${valueLabel(type.id)} (${type.value.unit})`}>
          <input
            inputMode="decimal"
            aria-label={valueLabel(type.id)}
            value={draft.displayValue}
            onChange={(e) => patch({ displayValue: e.target.value })}
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
          value={draft.metadata[field.id] ?? ''}
          onChange={(v) => patch({ metadata: { ...draft.metadata, [field.id]: v } })}
        />
      ))}

      <Field label={zhTW.addEvent.note}>
        <input
          aria-label={zhTW.addEvent.note}
          value={draft.note}
          onChange={(e) => patch({ note: e.target.value })}
          placeholder={zhTW.addEvent.notePlaceholder}
          className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
        />
      </Field>
    </>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
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
                className="min-h-11 flex-1 rounded-xl border py-3 text-sm"
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
          aria-label={metadataLabel(field.id)}
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
        aria-label={metadataLabel(field.id)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={field.maxLength}
        className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
      />
    </Field>
  );
}
