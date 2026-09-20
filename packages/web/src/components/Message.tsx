import { zhTW } from '@dongfan/shared';

/** A whole-screen notice, for the states before any data exists. */
export function Message({ text, onRetry }: { text: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="text-sm text-ink-muted">{text}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 rounded-xl border border-line px-6 text-sm text-ink-muted"
        >
          {zhTW.error.retry}
        </button>
      ) : null}
    </div>
  );
}
