import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import {
  CATEGORY_IDS, categoryName, eventTypeName,
  eventTypesInCategory, getEventType, interpolate, metadataOptionLabel, zhTW,
} from '@dongfan/shared';
import { EventIcon, EventIconBadge } from '../components/EventIcon.js';
import { ErrorLine } from '../components/FieldErrors.js';
import { useCreateEvent } from '../lib/create-event.js';
import { addQuery, askedDay, dayView, startFor } from '../lib/dated-add.js';
import { linkBack } from '../lib/return-to.js';
import { useStore } from '../lib/store.js';

/**
 * Type picker, grouped by category.
 *
 * Diaper is expanded into its three kinds rather than opening a form,
 * because a shortcut that still needs a second screen gets skipped at 3am
 * and the day ends up full of unclassified entries (spec 7.3).
 */
export function AddEvent(): React.JSX.Element {
  const navigate = useNavigate();
  const create = useCreateEvent('diaper');
  const { baby } = useStore();
  const [search] = useSearchParams();

  /** The day this add was started from, when it was not today's screen. */
  const day = askedDay(search.toString());
  /**
   * The screen it was started from, when that was not the home screen.
   *
   * The day alone is not enough: `dayView` names the single-day calendar, so
   * adding from the two-day view and saving left it. Which day a record is
   * filed under and which screen somebody is looking at are two questions.
   */
  const from = search.get('from');

  /**
   * Where this screen goes when it is finished with, decided once.
   *
   * Both ways out used to work it out separately, and only one of them knew
   * about `from` -- so a shortcut that turned into an edit left the two-day
   * view while the ordinary one came back to it.
   */
  const back = from ?? (day === null ? '/' : dayView(day, baby.timezone, Date.now()));

  const diaper = getEventType('diaper');

  const recordDiaper = async (kind: string): Promise<void> => {
    if (!diaper || create.busy) return;

    // Decided here, at the press, and used both for the record and for
    // where to go afterwards so the two cannot disagree. For today that
    // is the clock: taken when the screen opened, a shortcut left sitting
    // for five minutes would file the nappy five minutes early -- and
    // across midnight, on the wrong day. A retry ignores this and resends
    // what the queue already holds anyway.
    const startedAt = startFor(day, baby.timezone, Date.now());

    // The shortcut retries through the same hook as the form, so tapping
    // again after a failure reaches the same event rather than adding a
    // second nappy to the day (spec 3.8).
    const result = await create.submit({
      typeId: diaper.id,
      intent: 'record',
      startedAt,
      endedAt: null,
      note: '',
      metadata: { diaper_kind: kind },
      // The shortcut has no form, so it has no tags to carry. Tagging one
      // is what the full form is for.
      tagIds: [],
    });

    // Queued counts as recorded: it is written down, and the home screen
    // says how many are still waiting (spec 6.1). Only a refusal keeps
    // the parent on this screen.
    if (result.kind === 'failed') return;
    if (result.kind === 'gone') {
      // The queue sent this entry while the screen was open, so it is a
      // stored record now and belongs to the edit screen -- which still has
      // to know where all of this started (spec 6.1, 6.3).
      navigate(linkBack(`/event/${result.eventId}`, back));
      return;
    }
    // Back to the screen this was entered from, on the day it was
    // showing -- never to today (spec 7.3).
    navigate(back);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 items-center border-b border-line-soft px-2 py-2">
        <Link
          to={back}
          aria-label={zhTW.addEvent.cancel}
          className="flex size-11 items-center justify-center text-ink-muted"
        >
          <ChevronLeft size={22} />
        </Link>
        <span className="-ml-11 flex-1 text-center text-base font-medium">{zhTW.addEvent.title}</span>
      </header>

      {/* Said out loud. A screen that looks exactly like the one for now,
          but files what it is given under a day three weeks ago, is worse
          than no shortcut at all. */}
      {day !== null ? (
        <p
          className="shrink-0 border-b border-line-soft bg-surface px-4 py-2 text-center text-xs text-accent"
          data-testid="adding-on"
        >
          {interpolate(zhTW.addEvent.onDate, { date: day })}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-8">
        {diaper ? (
          <section className="mb-4">
            <h2 className="mb-2 text-xs font-medium tracking-widest text-ink-faint">
              {eventTypeName('diaper')}
            </h2>
            <div className="grid grid-cols-3 gap-2.5">
              {['pee', 'poo', 'both'].map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={create.busy}
                  onClick={() => void recordDiaper(kind)}
                  className="flex min-h-11 flex-col items-center gap-1.5 rounded-2xl border p-3 disabled:opacity-60"
                  style={{ borderColor: `${diaper.color}55`, backgroundColor: `${diaper.color}14` }}
                >
                  <EventIconBadge icon={diaper.icon} color={diaper.color} diameter={40} size={20} />
                  <span className="text-xs text-ink-muted">{metadataOptionLabel('diaper_kind', kind)}</span>
                </button>
              ))}
            </div>
            {create.outcomeUnknown ? (
              <p className="mt-3 text-xs leading-relaxed text-amber-300/90" data-testid="outcome-unknown">
                {zhTW.addEvent.outcomeUnknown}
              </p>
            ) : null}
            <ErrorLine failure={create.failure} />
          </section>
        ) : null}

        {CATEGORY_IDS.map((category) => {
          const types = eventTypesInCategory(category).filter((t) => t.id !== 'diaper');
          if (types.length === 0) return null;
          return (
            <section key={category} className="mb-4">
              <h2 className="mb-2 text-xs font-medium tracking-widest text-ink-faint">
                {categoryName(category)}
              </h2>
              <div className="grid grid-cols-5 gap-2.5">
                {types.map((type) => (
                  <Link
                    key={type.id}
                    to={`/add/${type.id}${addQuery(day, from)}`}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <span
                      className="flex size-12 items-center justify-center rounded-full border"
                      style={{ borderColor: `${type.color}52`, backgroundColor: `${type.color}24` }}
                    >
                      <EventIcon icon={type.icon} color={type.color} size={22} />
                    </span>
                    <span className="text-center text-[11px] leading-tight text-ink-muted">
                      {eventTypeName(type.id)}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
