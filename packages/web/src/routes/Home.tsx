import { Link } from 'react-router-dom';
import { Menu, Plus, Settings } from 'lucide-react';
import {
  ageAt, eventTypeName, formatValue, getEventType, interpolate,
  metadataOptionLabel, zhTW,
} from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import { EventIconBadge, FALLBACK_COLOR } from '../components/EventIcon.js';
import { QuickActions } from '../components/QuickActions.js';
import { formatClock, formatDuration, relativeTime } from '../lib/format.js';
import { typeSummary, useStore } from '../lib/store.js';
import { useSession } from '../lib/session.js';

export function Home(): React.JSX.Element {
  const { baby, summary, events, now, stale } = useStore();
  const { signOut } = useSession();

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
        <span className="text-[13px] text-ink-faint" data-testid="sync-state">
          {stale ? zhTW.home.syncFailed : zhTW.home.syncedJustNow}
        </span>
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

      <QuickActions />

      <div className="flex shrink-0 items-baseline justify-between px-4.5 pb-2">
        <span className="text-[13px] font-medium tracking-wide text-ink-muted">{zhTW.home.todayEvents}</span>
        <span className="font-numeric text-xs text-ink-dim" data-testid="today-count">
          {interpolate(zhTW.home.eventCount, { count: events.length })}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-24">
        {events.length === 0 ? (
          <EmptyState />
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} timezone={baby.timezone} />)
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

function EventRow({ event, timezone }: { event: EventDto; timezone: string }): React.JSX.Element {
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
          {event.active ? (
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
