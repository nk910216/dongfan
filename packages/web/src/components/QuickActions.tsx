import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EVENT_TYPES, eventTypeName, interpolate, quickActionTypes, zhTW } from '@dongfan/shared';
import type { EventTypeConfig } from '@dongfan/shared';
import { EventIcon, EventIconBadge } from './EventIcon.js';
import { formatStopwatch, relativeTime } from '../lib/format.js';
import { typeSummary, useStore } from '../lib/store.js';

/**
 * The strip of one-tap shortcuts.
 *
 * A type with a running timer takes over its own card rather than getting a
 * separate banner: it saves vertical space on a phone, and puts the stop
 * button within thumb reach instead of at the top of the screen.
 */
export function QuickActions(): React.JSX.Element {
  const { summary, now, stopTimer } = useStore();
  const [stopping, setStopping] = useState<string | null>(null);

  // A running timer must always be stoppable from here. Walk and play can be
  // started from the picker but are not shortcuts, so without this they
  // would run with no way to end them until editing exists.
  const running: EventTypeConfig[] = EVENT_TYPES.filter(
    (type) => !type.quickAction && typeSummary(summary, type.id)?.activeEventId != null,
  );
  const visible = [...running, ...quickActionTypes()];

  return (
    <div className="flex shrink-0 gap-2.5 overflow-x-auto px-3.5 pb-3.5 [scrollbar-width:none]">
      {visible.map((type) => {
        const entry = typeSummary(summary, type.id);
        const isRunning = entry?.activeEventId != null && entry.activeStartedAt != null;

        if (isRunning && entry) {
          const elapsed = now - (entry.activeStartedAt ?? now);
          return (
            <div
              key={type.id}
              className="flex w-[118px] shrink-0 flex-col gap-1.5 rounded-2xl border-[1.5px] p-3"
              style={{ borderColor: type.color, backgroundColor: `${type.color}20` }}
            >
              <div className="flex items-center gap-1.5">
                <EventIcon icon={type.icon} color={type.color} size={18} />
                <span className="text-[13px]" style={{ color: type.color }}>
                  {interpolate(zhTW.timer.running, { name: eventTypeName(type.id) })}
                </span>
              </div>
              <span className="font-numeric text-[22px] font-semibold tracking-tight tabular-nums">
                {formatStopwatch(elapsed)}
              </span>
              <button
                type="button"
                disabled={stopping === entry.activeEventId}
                onClick={() => {
                  const id = entry.activeEventId;
                  const version = entry.activeVersion;
                  if (id === null || version === null) return;
                  setStopping(id);
                  // The end time is read once, here, so what gets stored is
                  // the moment the button was pressed rather than whenever
                  // the request happened to reach the server.
                  void stopTimer(id, version, Date.now()).finally(() => setStopping(null));
                }}
                className="min-h-11 rounded-lg px-3 text-[13px] font-bold text-ground disabled:opacity-60"
                style={{ backgroundColor: type.color }}
              >
                {zhTW.timer.stop}
              </button>
            </div>
          );
        }

        return (
          <div
            key={type.id}
            className="flex w-[92px] shrink-0 flex-col items-center gap-1.5 rounded-2xl border border-line bg-surface p-2.5"
          >
            <EventIconBadge icon={type.icon} color={type.color} diameter={34} size={19} />
            <span className="text-[13px] font-medium">{eventTypeName(type.id)}</span>
            <span className="text-[11px] text-ink-faint">
              {relativeTime(entry?.lastStartedAt ?? null, now)}
            </span>
            <Link
              to={`/add/${type.id}`}
              aria-label={`${zhTW.addEvent.title} ${eventTypeName(type.id)}`}
              className="flex min-h-11 w-full items-center justify-center rounded-lg bg-surface-raised text-base font-semibold"
              style={{ color: type.color }}
            >
              ＋
            </Link>
          </div>
        );
      })}
    </div>
  );
}
