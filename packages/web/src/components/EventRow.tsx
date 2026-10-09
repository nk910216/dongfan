import { Link } from 'react-router-dom';
import {
  eventTypeName, formatValue, getEventType, interpolate, metadataOptionLabel, zhTW,
} from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import { EventIconBadge, FALLBACK_COLOR } from './EventIcon.js';
import type { QueuedCreate } from '../lib/db.js';
import { formatClock, formatDuration, formatShortDate } from '../lib/format.js';
import { linkBack } from '../lib/return-to.js';

/**
 * One line of a day, wherever that day is being shown.
 *
 * Here rather than in the home screen because spec 7.5 asks for the
 * calendar's events to look like the home screen's, and two copies of this
 * would answer that on the day they were written and then drift. A badge
 * added to one and not the other is the kind of difference nobody notices
 * until a parent reads the same record two ways on two screens.
 */

/** What a queued entry says about itself, before the server has seen it. */
export function describeQueued(entry: QueuedCreate, timezone: string): string {
  const type = getEventType(entry.input.typeId);
  const parts: string[] = [];

  if (type?.allDay) parts.push(zhTW.event.allDay);
  else parts.push(formatClock(entry.input.startedAt, timezone));

  if (type?.value && entry.input.value !== undefined) {
    parts.push(`${formatValue(entry.input.value, type.value)}${type.value.unit}`);
  }
  for (const [key, value] of Object.entries(entry.input.metadata)) {
    if (value !== '') parts.push(metadataOptionLabel(key, value));
  }
  if (entry.input.note !== '') parts.push(entry.input.note);

  return parts.join(' · ');
}

/**
 * A record this device is still holding.
 *
 * Deliberately not dressed as a synced one. Spec 6.2 asks for pending
 * entries to be shown alongside the rest and to be tellable apart at a
 * glance, so this one is dimmer, carries a badge, and leads to the list
 * where something can be done about it rather than to an edit screen for
 * an event the server has never heard of.
 */
export function WaitingRow({ entry, timezone }: {
  entry: QueuedCreate;
  timezone: string;
}): React.JSX.Element {
  const type = getEventType(entry.input.typeId);
  const color = type?.color ?? FALLBACK_COLOR;

  return (
    <Link
      to="/unsynced"
      className="flex items-center gap-2.5 border-b border-dashed border-line px-1 py-2.5 opacity-70"
      data-testid={`waiting-row-${entry.input.typeId}`}
    >
      <EventIconBadge icon={type?.icon ?? 'circle-ellipsis'} color={color} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[15px] font-medium">{eventTypeName(entry.input.typeId)}</span>
          <span className="rounded border border-warn/60 px-1.5 py-px text-[10px] text-warn-soft">
            {zhTW.unsynced.badge}
          </span>
        </div>
        <div className="mt-px truncate text-xs text-ink-faint">{describeQueued(entry, timezone)}</div>
      </div>
    </Link>
  );
}

export function EventRow({ event, timezone, drafted, today, from }: {
  event: EventDto;
  timezone: string;
  /** Stopped on this device, with nobody having confirmed when yet. */
  drafted: boolean;
  /**
   * Given, the row leads with its day as well as the clock -- with the year
   * when it is not this one. A day's list does not need it; the tag page's
   * spans months, and "08:12" alone there says nothing.
   */
  today?: string;
  /** Where the edit screen goes back to; home when nothing says otherwise. */
  from?: string;
}): React.JSX.Element {
  const type = getEventType(event.typeId);
  const color = type?.color ?? FALLBACK_COLOR;
  const spec = type?.value ?? null;

  const details: string[] = [];
  if (today !== undefined) details.push(formatShortDate(event.localDate, today));
  if (type?.allDay) details.push(zhTW.event.allDay);
  else details.push(formatClock(event.startedAt, timezone));

  if (event.endedAt !== null && type?.hasRange) {
    details.push(formatDuration(event.endedAt - event.startedAt));
  }
  for (const [key, value] of Object.entries(event.metadata)) {
    if (value !== '') details.push(metadataOptionLabel(key, value));
  }

  return (
    <Link
      to={from === undefined ? `/event/${event.id}` : linkBack(`/event/${event.id}`, from)}
      aria-label={interpolate(zhTW.event.open, { name: eventTypeName(event.typeId) })}
      className="flex items-center gap-2.5 border-b border-line-soft px-1 py-2.5"
      data-testid={`event-row-${event.typeId}`}
    >
      <EventIconBadge icon={type?.icon ?? 'circle-ellipsis'} color={color} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[15px] font-medium">{eventTypeName(event.typeId)}</span>
          {/* "Still running" and "stopped, but only here" have to look
              different. A parent who cannot tell them apart either stops
              it a second time or leaves it running all night (spec 7.2). */}
          {drafted ? (
            <span className="rounded border border-dashed border-warn/70 px-1.5 py-px text-[10px] text-warn-soft">
              {zhTW.stopDraft.badge}
            </span>
          ) : event.active ? (
            <span className="rounded border px-1.5 py-px text-[10px]" style={{ color, borderColor: `${color}66` }}>
              {zhTW.event.inProgress}
            </span>
          ) : null}
        </div>
        <div className="mt-px truncate text-xs text-ink-faint">{details.join(' · ')}</div>
      </div>
      {spec ? (
        <span className="font-numeric shrink-0 text-[15px] font-semibold" style={{ color }}>
          {formatValue(event.value, spec)}
          <span className="text-[11px] text-ink-faint">{spec.unit}</span>
        </span>
      ) : null}
    </Link>
  );
}

/** Nothing recorded. The wording differs between today and any other day. */
export function EmptyDay({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-line-soft bg-surface px-4 py-10">
      <p className="text-sm text-ink-muted">{title}</p>
      {hint ? <p className="text-xs text-ink-dim">{hint}</p> : null}
    </div>
  );
}
