import { fromLocalInput, toLocalInput, zhTW } from '@dongfan/shared';

/**
 * Picks a moment in the baby's timezone.
 *
 * The browser control works in the device's timezone, so its value is never
 * used as an instant directly: converting both ways through the shared
 * helpers is what stops a parent in another timezone filing a night feed
 * under the wrong day (spec 3.4).
 */
export function DateTimeField({
  label, value, timeZone, onChange, onClear, testId,
}: {
  label: string;
  value: number | null;
  timeZone: string;
  onChange: (instant: number) => void;
  /** Present only where an empty value is meaningful, such as an end time. */
  onClear?: () => void;
  testId?: string;
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
        type="datetime-local"
        aria-label={label}
        data-testid={testId}
        value={value === null ? '' : toLocalInput(value, timeZone)}
        onChange={(event) => {
          const instant = fromLocalInput(event.target.value, timeZone);
          if (instant !== null) onChange(instant);
        }}
        className="w-full rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
      />

      {value === null ? (
        <p className="mt-1 text-[11px] text-ink-dim">{zhTW.addEvent.endedAtEmpty}</p>
      ) : null}
    </div>
  );
}
