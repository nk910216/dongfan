import {
  fromLocalInput, isRealLocalDate, startOfLocalDay, toLocalDate, toLocalInput, zhTW,
} from '@dongfan/shared';

/**
 * Picks a moment in the baby's timezone.
 *
 * The browser control works in the device's timezone, so its value is never
 * used as an instant directly: converting both ways through the shared
 * helpers is what stops a parent in another timezone filing a night feed
 * under the wrong day (spec 3.4).
 */
export function DateTimeField({
  label, value, timeZone, onChange, onClear, testId, dateOnly = false,
}: {
  label: string;
  value: number | null;
  timeZone: string;
  onChange: (instant: number) => void;
  /** Present only where an empty value is meaningful, such as an end time. */
  onClear?: () => void;
  testId?: string;
  /**
   * For all-day events, which have no clock time at all.
   *
   * Offering one would let a parent set 14:30 and watch the server pin it
   * to midnight, which looks like the app losing their input (spec 3.9).
   */
  dateOnly?: boolean;
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs tracking-wide text-ink-faint">{label}</span>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onChange(Date.now())}
            className="text-xs text-accent"
          >
            {zhTW.addEvent.endNow}
          </button>
          {onClear && value !== null ? (
            <button type="button" onClick={onClear} className="text-xs text-ink-dim">
              {zhTW.addEvent.clearEnd}
            </button>
          ) : null}
        </div>
      </div>

      <input
        type={dateOnly ? 'date' : 'datetime-local'}
        aria-label={label}
        data-testid={testId}
        value={value === null ? '' : dateOnly ? toLocalDate(value, timeZone) : toLocalInput(value, timeZone)}
        onChange={(event) => {
          const typed = event.target.value;
          if (dateOnly) {
            // Midnight in the baby's timezone, which is exactly what the
            // server stores for an all-day event anyway.
            if (isRealLocalDate(typed)) onChange(startOfLocalDay(typed, timeZone));
            return;
          }
          const instant = fromLocalInput(typed, timeZone);
          if (instant !== null) onChange(instant);
        }}
        className="block min-h-12 w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
      />

      {value === null ? (
        <p className="mt-1 text-[11px] text-ink-dim">{zhTW.addEvent.endedAtEmpty}</p>
      ) : null}
    </div>
  );
}
