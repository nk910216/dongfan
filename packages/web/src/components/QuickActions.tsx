import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  EVENT_TYPES, MAX_EVENT_DURATION_MS, eventTypeName, interpolate, quickActionTypes, zhTW,
} from '@dongfan/shared';
import type { EventTypeConfig, TypeSummaryDto } from '@dongfan/shared';
import { ApiFailure } from '../lib/api.js';
import { describeFailure } from './FieldErrors.js';
import { EventIcon, EventIconBadge } from './EventIcon.js';
import { formatStopwatch, relativeTime } from '../lib/format.js';
import { draftFor, typeSummary, useStore } from '../lib/store.js';

/**
 * The strip of one-tap shortcuts.
 *
 * A type with a running timer takes over its own card rather than getting a
 * separate banner: it saves vertical space on a phone, and puts the stop
 * button within thumb reach instead of at the top of the screen.
 */
export function QuickActions(): React.JSX.Element {
  const { summary, now, stopTimer, refresh, stopDrafts } = useStore();
  const [stopping, setStopping] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  // A running timer must always be stoppable from here. Walk and play can be
  // started from the picker but are not shortcuts, so without this they
  // would run with no way to end them until editing exists.
  const running: EventTypeConfig[] = EVENT_TYPES.filter(
    (type) => !type.quickAction && typeSummary(summary, type.id)?.activeEventId != null,
  );
  const visible = [...running, ...quickActionTypes()];

  const stop = async (entry: TypeSummaryDto): Promise<void> => {
    const id = entry.activeEventId;
    const version = entry.activeVersion;
    if (id === null || version === null) return;


    setStopping(id);
    setFailure(null);
    try {
      // The end time is read once, here, so what gets stored is the moment
      // the button was pressed rather than whenever the request happened to
      // reach the server.
      await stopTimer(id, version, Date.now());
    } catch (error) {
      setFailure(error);
      // A stale version will fail again at the next press, and again, until
      // something fetches the one the other phone left behind.
      if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
        await refresh().catch(() => undefined);
      }
    } finally {
      setStopping(null);
    }
  };

  return (
    <div className="shrink-0">
      {failure !== null ? (
        <p className="px-4.5 pb-2 text-xs text-red-300" data-testid="timer-error">
          {zhTW.timer.stopFailed} · {describeFailure(failure)}
        </p>
      ) : null}

      <div className="flex gap-2.5 overflow-x-auto px-3.5 pb-3.5 [scrollbar-width:none]">
        {visible.map((type) => {
          const entry = typeSummary(summary, type.id);
          const startedAt = entry?.activeStartedAt ?? null;

          if (entry && entry.activeEventId !== null && startedAt !== null) {
            const elapsed = now - startedAt;
            const draft = draftFor(stopDrafts, entry.activeEventId);

            // Stopped, but only on this device. Spec 7.2 asks for this to
            // be tellable apart from a timer that is still running and
            // from one that has been recorded: the clock stops at the
            // moment the button was pressed, there is no stop button to
            // press again, and what it offers instead is the confirmation
            // that will actually send it.
            if (draft) {
              return (
                <Link
                  key={type.id}
                  to={`/stop/${entry.activeEventId}`}
                  className="flex w-[132px] shrink-0 flex-col gap-1.5 rounded-2xl border-[1.5px] border-dashed border-warn bg-warn/10 p-3"
                  data-testid={`timer-drafted-${type.id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <EventIcon icon={type.icon} color="#E8925C" size={16} />
                    <span className="text-[12px] leading-tight text-warn-soft">
                      {zhTW.stopDraft.badge}
                    </span>
                  </div>
                  <span className="font-numeric text-[20px] font-semibold tracking-tight tabular-nums text-warn">
                    {formatStopwatch(Math.max(0, draft.endedAt - startedAt))}
                  </span>
                  <span className="flex min-h-11 items-center justify-center rounded-lg bg-warn px-2 text-center text-[12px] font-bold leading-tight text-ground">
                    {zhTW.stopDraft.confirm}
                  </span>
                </Link>
              );
            }

            // Past a day the API will refuse any end time, because that
            // ceiling is what keeps an event to at most one midnight
            // crossing (spec 3.4.1). A stop button here could only fail, so
            // the card sends the parent to the form to say when it really
            // ended -- otherwise the slot stays occupied with no way out,
            // and the event is no longer in today's list to tap (spec 7.2).
            if (elapsed > MAX_EVENT_DURATION_MS) {
              return (
                <div
                  key={type.id}
                  className="flex w-[132px] shrink-0 flex-col gap-1.5 rounded-2xl border-[1.5px] border-warn bg-warn/10 p-3"
                  data-testid={`timer-overrun-${type.id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <EventIcon icon="triangle-alert" color="#E8925C" size={16} />
                    <span className="text-[12px] leading-tight text-warn-soft">
                      {interpolate(zhTW.timer.overrun, { name: eventTypeName(type.id) })}
                    </span>
                  </div>
                  <span className="font-numeric text-[20px] font-semibold tracking-tight tabular-nums text-warn">
                    {formatStopwatch(elapsed)}
                  </span>
                  <Link
                    to={`/event/${entry.activeEventId}`}
                    className="flex min-h-11 items-center justify-center rounded-lg bg-warn px-2 text-center text-[12px] font-bold leading-tight text-ground"
                  >
                    {zhTW.timer.confirmEnd}
                  </Link>
                </div>
              );
            }

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
                  onClick={() => void stop(entry)}
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
    </div>
  );
}
