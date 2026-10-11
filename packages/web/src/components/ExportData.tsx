import { useState } from 'react';
import { interpolate, toLocalDate, zhTW } from '@dongfan/shared';
import { describeFailure } from './FieldErrors.js';
import { OfflineError } from '../lib/api.js';
import { toCsv } from '../lib/export-csv.js';
import { saveFile } from '../lib/save-file.js';
import { ExportIncomplete, useStore } from '../lib/store.js';

/**
 * The settings page's export (spec 5.9): every record the server holds for
 * this baby, as a spreadsheet or as JSON.
 *
 * **From the server, whole, or not at all.** Not the device's copy, which
 * may be behind, and never a first page. A file that arrives short, or not
 * at all, is reported as a failure with nothing saved -- an export that
 * looks complete and is not is worse than no export.
 *
 * **What is waiting on this phone is not in it**, because the server has
 * not got it yet, and the screen says so before anybody presses anything.
 *
 * **Success is stated as what this page knows**: a file was made and handed
 * to the browser. Whether it was saved, the browser does not say.
 */

type Format = 'csv' | 'json';

type Outcome =
  | { kind: 'ready'; name: string; count: number }
  | { kind: 'failed'; format: Format; error: unknown };

export function ExportData(): React.JSX.Element {
  const { unsynced, exportData } = useStore();
  const [busy, setBusy] = useState<Format | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async (format: Format): Promise<void> => {
    if (busy !== null) return;
    setBusy(format);
    setOutcome(null);
    try {
      const { document, json } = await exportData();
      const day = toLocalDate(document.exportedAt, document.baby.timezone);
      const name = `dongfan-${day}.${format}`;
      if (format === 'csv') saveFile(name, toCsv(document), 'text/csv;charset=utf-8');
      else saveFile(name, json, 'application/json;charset=utf-8');
      setOutcome({ kind: 'ready', name, count: document.eventCount });
    } catch (error) {
      setOutcome({ kind: 'failed', format, error });
    } finally {
      setBusy(null);
    }
  };

  const reason = (error: unknown): string => {
    if (error instanceof ExportIncomplete) return zhTW.settings.exportIncomplete;
    // The shared wording for this one says editing and deleting need a
    // connection, which is true and beside the point here.
    if (error instanceof OfflineError) return zhTW.error.offline;
    return describeFailure(error);
  };

  return (
    <div data-testid="export">
      <p className="mb-3 text-xs leading-relaxed text-ink-faint">{zhTW.settings.exportHint}</p>

      {unsynced.length > 0 ? (
        <p className="mb-3 text-xs leading-relaxed text-warn-soft" data-testid="export-unsynced">
          {interpolate(zhTW.settings.exportUnsynced, { count: unsynced.length })}
        </p>
      ) : null}

      <div className="flex gap-2">
        {(['csv', 'json'] as const).map((format) => (
          <button
            key={format}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(format)}
            data-testid={`export-${format}`}
            className="min-h-11 flex-1 rounded-xl border border-line text-sm text-accent disabled:opacity-60"
          >
            {busy === format
              ? zhTW.settings.exporting
              : format === 'csv' ? zhTW.settings.exportCsv : zhTW.settings.exportJson}
          </button>
        ))}
      </div>

      {outcome?.kind === 'ready' ? (
        <p className="mt-2.5 text-xs text-ink-muted" data-testid="export-ready">
          {interpolate(zhTW.settings.exportReady, { name: outcome.name, count: outcome.count })}
        </p>
      ) : null}

      {outcome?.kind === 'failed' ? (
        <div className="mt-2.5" data-testid="export-failed">
          <p className="text-xs text-red-300">{zhTW.settings.exportFailed}</p>
          <p className="mt-0.5 text-xs text-ink-dim">{reason(outcome.error)}</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run(outcome.format)}
            data-testid="export-retry"
            className="mt-1.5 min-h-11 rounded-xl border border-line px-4 text-sm text-ink-muted disabled:opacity-60"
          >
            {zhTW.settings.exportRetry}
          </button>
        </div>
      ) : null}
    </div>
  );
}
