import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Menu, Plus, Settings } from 'lucide-react';
import {
  ageAt, eventTypeName, formatValue, getEventType, interpolate,
  metadataOptionLabel, toLocalDate, zhTW,
} from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import { EventIconBadge, FALLBACK_COLOR } from '../components/EventIcon.js';
import { InstallHint } from '../components/InstallHint.js';
import { QuickActions } from '../components/QuickActions.js';
import type { QueuedCreate } from '../lib/db.js';
import { formatClock, formatDuration, relativeTime, syncedAgo } from '../lib/format.js';
import { draftFor, typeSummary, useStore } from '../lib/store.js';
import { describeQueued } from './Unsynced.js';
import { useSession } from '../lib/session.js';

export function Home(): React.JSX.Element {
  const {
    baby, summary, events, now, stale, syncing, syncedAt, refresh, unsynced, stopDrafts,
  } = useStore();
  const { signOut } = useSession();

  /**
   * The waiting records that belong on today's list.
   *
   * They have to be visible, not just counted. A parent who recorded a
   * feed in a room with no signal and then cannot see it on the screen
   * records it again, and the duplicate is the thing all of this exists
   * to avoid (spec 6.2).
   *
   * An entry whose event is already here is left out: between the queue
   * removing it and this screen reading both stores again there is a
   * moment where each has a copy, and showing the same feed twice would
   * be its own small lie.
   */
  // Held as a string, so the clock ticking every second does not make this
  // list rebuild every second. The date comes from the baby's timezone,
  // never the device's.
  const today = toLocalDate(now, baby.timezone);
  const waiting = useMemo(() => {
    const known = new Set(events.map((event) => event.id));
    return unsynced.filter(
      (entry) =>
        !known.has(entry.eventId) &&
        toLocalDate(entry.input.startedAt, baby.timezone) === today,
    );
  }, [unsynced, events, baby.timezone, today]);

  const age = ageAt(baby.birthDate, now, baby.timezone);
  const height = typeSummary(summary, 'height')?.lastValue ?? null;
  const weight = typeSummary(summary, 'weight')?.lastValue ?? null;
  const heightSpec = getEventType('height')?.value ?? null;
  const weightSpec = getEventType('weight')?.value ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between px-2 pt-2.5 pb-1.5">
        <button type="button" aria-label={zhTW.a11y.openMenu} className="flex size-11 items-center justify-center text-ink-muted">
          <Menu size={22} />
        </button>
        {/* Tappable, because the automatic pulls cover coming back to the
            app and coming back online, and neither covers standing in the
            kitchen wondering whether the other parent has recorded the
            feed yet (spec 6.1). */}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={syncing}
          aria-label={zhTW.a11y.sync}
          className="text-[13px] text-ink-faint disabled:opacity-60"
          data-testid="sync-state"
        >
          {syncing ? zhTW.home.syncing : stale ? zhTW.home.syncFailed : syncedAgo(syncedAt, now)}
        </button>
        <button
          type="button"
          onClick={signOut}
          aria-label={zhTW.auth.signOut}
          className="flex size-11 items-center justify-center text-ink-muted"
        >
          <Settings size={22} />
        </button>
      </header>

      {/* Identity is one horizontal strip rather than a stacked block: it frees
          about 60px for the event list, which is what the screen is for. */}
      <section className="flex shrink-0 items-center gap-3 px-4.5 pb-3.5">
        <div className="flex size-13 shrink-0 items-center justify-center rounded-full border-[1.5px] border-accent bg-surface-raised text-2xl">
          <span aria-hidden>🌱</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[21px] font-bold tracking-wide">{baby.nickname}</h1>
            <span className="font-numeric text-sm text-ink-muted">
              {interpolate(zhTW.home.age, age)}
            </span>
          </div>
          <div className="mt-0.5 flex gap-3.5 text-[13px] text-ink-faint">
            <span>
              {zhTW.home.height}{' '}
              <span className="font-numeric text-ink-muted">
                {height !== null && heightSpec ? (Number(formatValue(height, heightSpec)) / 10).toFixed(1) : zhTW.app.noValue}
              </span>{' '}
              cm
            </span>
            <span>
              {zhTW.home.weight}{' '}
              <span className="font-numeric text-ink-muted">
                {weight !== null && weightSpec ? (Number(formatValue(weight, weightSpec)) / 1000).toFixed(2) : zhTW.app.noValue}
              </span>{' '}
              kg
            </span>
          </div>
        </div>
      </section>

      {/* What matters when handing over care is the last few hours, not the
          growth figures that change once a week (spec 7.2). */}
      <section className="mx-3.5 mb-3.5 flex shrink-0 rounded-2xl border border-line bg-surface px-1.5 py-3">
        <SummaryCell label={zhTW.home.lastFeed} color="#74D39A">
          {relativeTime(summary.lastFeedAt, now)}
        </SummaryCell>
        <Divider />
        <SummaryCell label={zhTW.home.todayMilk} color="#5FC9B0">
          {summary.today.totalBottleMl}
          <span className="text-xs font-medium">ml</span>
        </SummaryCell>
        <Divider />
        <SummaryCell
          label={zhTW.home.todayDiaper}
          color="#E8B15C"
          captionTestId="diaper-breakdown"
          caption={interpolate(zhTW.home.diaperBreakdown, {
            pee: summary.today.diaper.pee,
            poo: summary.today.diaper.poo,
            unknown: summary.today.diaper.unknown,
          })}
        >
          {summary.today.diaper.total}
        </SummaryCell>
      </section>

      <InstallHint />

      {/* Never implied. Storage here can be cleared by the browser without
          warning, so a parent has to be told outright how many of their
          records this phone is still holding (spec 6.1, 9.6). */}
      {unsynced.length > 0 ? (
        <Link
          to="/unsynced"
          data-testid="unsynced-count"
          className="mx-3.5 mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn-soft"
        >
          {interpolate(zhTW.home.unsynced, { count: unsynced.length })}
        </Link>
      ) : null}

      {/* Separate from the count above, because they are different
          problems: one is waiting to be sent, this one is waiting for
          somebody to say what time it actually was (spec 7.2). */}
      {stopDrafts.length > 0 ? (
        <Link
          to={`/stop/${stopDrafts[0]?.eventId ?? ''}`}
          data-testid="stop-drafts"
          className="mx-3.5 mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-warn/50 bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn-soft"
        >
          {interpolate(zhTW.home.stopDrafts, { count: stopDrafts.length })}
        </Link>
      ) : null}

      <QuickActions />

      <div className="flex shrink-0 items-baseline justify-between px-4.5 pb-2">
        <span className="text-[13px] font-medium tracking-wide text-ink-muted">{zhTW.home.todayEvents}</span>
        <span className="font-numeric text-xs text-ink-dim" data-testid="today-count">
          {/* Counts the waiting ones too, because they are on the list
              below. A count that disagreed with what is visible would send
              somebody looking for a record that is right in front of
              them. */}
          {interpolate(zhTW.home.eventCount, { count: events.length + waiting.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-24">
        {events.length === 0 && waiting.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {waiting.map((entry) => (
              <WaitingRow key={entry.eventId} entry={entry} timezone={baby.timezone} />
            ))}
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                timezone={baby.timezone}
                drafted={draftFor(stopDrafts, event.id) !== null}
              />
            ))}
          </>
        )}
      </div>

      <Link
        to="/add"
        aria-label={zhTW.a11y.addEvent}
        className="absolute right-4.5 bottom-6 flex size-15 items-center justify-center rounded-full bg-accent shadow-lg shadow-black/50"
      >
        <Plus size={26} className="text-ground" strokeWidth={2.6} />
      </Link>
    </div>
  );
}

function Divider(): React.JSX.Element {
  return <div className="my-0.5 w-px bg-line" />;
}

function SummaryCell({
  label, color, caption, captionTestId, children,
}: {
  label: string; color: string; caption?: string; captionTestId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center gap-0.5">
      <span className="text-[11px] text-ink-faint">{label}</span>
      <span className="font-numeric text-[19px] font-semibold" style={{ color }}>
        {children}
      </span>
      {caption ? (
        <span className="text-[10px] text-ink-dim" data-testid={captionTestId}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-line-soft bg-surface px-4 py-10">
      <p className="text-sm text-ink-muted">{zhTW.home.emptyTitle}</p>
      <p className="text-xs text-ink-dim">{zhTW.home.emptyHint}</p>
    </div>
  );
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
function WaitingRow({ entry, timezone }: { entry: QueuedCreate; timezone: string }): React.JSX.Element {
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

function EventRow({ event, timezone, drafted }: {
  event: EventDto;
  timezone: string;
  /** Stopped on this device, with nobody having confirmed when yet. */
  drafted: boolean;
}): React.JSX.Element {
  const type = getEventType(event.typeId);
  const color = type?.color ?? FALLBACK_COLOR;
  const spec = type?.value ?? null;

  const details: string[] = [];
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
      to={`/event/${event.id}`}
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
