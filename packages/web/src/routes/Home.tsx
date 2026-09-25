import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Settings } from 'lucide-react';
import {
  ageAt, formatValue, getEventType, interpolate, toLocalDate, zhTW,
} from '@dongfan/shared';
import { EmptyDay, EventRow, WaitingRow } from '../components/EventRow.js';
import { InstallHint } from '../components/InstallHint.js';
import { PageMenu } from '../components/PageMenu.js';
import { QuickActions } from '../components/QuickActions.js';
import { SyncState } from '../components/SyncState.js';
import { relativeTime } from '../lib/format.js';
import { draftFor, typeSummary, useStore } from '../lib/store.js';
import { useSession } from '../lib/session.js';

export function Home(): React.JSX.Element {
  const { baby, summary, events, now, unsynced, stopDrafts } = useStore();

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
        {/* Until now this had no handler at all, so the calendar had no
            way in. Spec 7.10 asks for a page list behind it. */}
        <PageMenu />
        <SyncState now={now} />
        <Link
          to="/settings"
          aria-label={zhTW.a11y.openSettings}
          className="flex size-11 items-center justify-center text-ink-muted"
        >
          <Settings size={22} />
        </Link>
      </header>

      {/* Identity is one horizontal strip rather than a stacked block: it frees
          about 60px for the event list, which is what the screen is for. */}
      <section className="flex shrink-0 items-center gap-3 px-4.5 pb-3.5">
        <div className="flex size-13 shrink-0 items-center justify-center rounded-full border-[1.5px] border-accent bg-surface-raised text-2xl">
          <span aria-hidden>🌱</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <BabyName nickname={baby.nickname} />
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
          <EmptyDay title={zhTW.home.emptyTitle} hint={zhTW.home.emptyHint} />
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

/**
 * The baby's name, and a way to another one.
 *
 * Only a button when there is somewhere to go. An account with one baby --
 * which is almost all of them -- gets a heading, because a control that
 * does nothing is worse than no control (spec 7.10).
 */
function BabyName({ nickname }: { nickname: string }): React.JSX.Element {
  const { me, activeBaby, selectBaby } = useSession();
  const [open, setOpen] = useState(false);

  const babies = me?.babies ?? [];
  if (babies.length < 2) {
    return <h1 className="text-[21px] font-bold tracking-wide">{nickname}</h1>;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={zhTW.settings.switchBaby}
        data-testid="switch-baby"
        className="text-[21px] font-bold tracking-wide underline decoration-line decoration-2 underline-offset-4"
      >
        {nickname}
      </button>

      {open ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 px-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
        >
          <div className="w-full rounded-2xl border border-line bg-surface-raised p-3">
            <p className="mb-2 px-1 text-xs tracking-widest text-ink-faint">
              {zhTW.settings.switchBaby}
            </p>
            {babies.map((other) => (
              <button
                key={other.id}
                type="button"
                data-testid={`choose-${other.id}`}
                onClick={() => {
                  selectBaby(other.id);
                  setOpen(false);
                }}
                className="flex min-h-11 w-full items-center rounded-xl px-3 text-left text-[15px]"
                style={other.id === activeBaby?.id ? { color: '#E8B15C' } : undefined}
              >
                {other.nickname}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
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

