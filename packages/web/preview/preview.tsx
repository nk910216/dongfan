import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AllDayBand, DayBand, Hours, TIMELINE_GUTTER, Timeline } from '../src/components/Timeline.js';
import {
  DEFAULT_METRICS, MINUTES_IN_DAY, columnsFor, itemsFor, layOut, minutesToPx,
} from '../src/lib/timeline.js';
import { DRAFTS, EARLIER, EARLIER_DAY, LATER, LATER_DAY, QUEUED, TZ } from './fixtures.js';
import '../src/index.css';

/**
 * The timeline on its own, with invented records, for looking at.
 *
 * Not part of the app: `vite build` takes `index.html` and nothing else, so
 * this is only ever served by the dev server. It exists because the whole
 * class of bug this layout has is invisible to the test suite -- jsdom
 * computes no geometry, so a bar clipped to a speck, a type name cut to one
 * character and words an hour away from the line they belong to all pass.
 *
 * It draws the bands the way the two routes do. That is a copy of about ten
 * lines of chrome, deliberately: what it must *not* copy is any of the
 * placement, which comes from `itemsFor`, `layOut` and the components the
 * screens use, or it would be a picture of itself.
 *
 *   /preview/timeline.html?view=day|two&at=<hour>&open=<day>@<minute>
 */

const params = new URLSearchParams(window.location.search);
const twoDays = params.get('view') === 'two';
const openAt = Number(params.get('at') ?? '6');

function useScrollTo(hour: number): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = minutesToPx(hour * 60, DEFAULT_METRICS);
  }, [hour]);
  return ref;
}

function Header({ title }: { title: string }): React.JSX.Element {
  return (
    <header className="flex shrink-0 flex-col px-2 pt-2.5 pb-1.5">
      <div className="flex min-h-11 items-center justify-center font-numeric text-base">
        {title}
      </div>
    </header>
  );
}

function OneDay(): React.JSX.Element {
  const bandWidth = window.innerWidth - TIMELINE_GUTTER;
  const columns = columnsFor(bandWidth, DEFAULT_METRICS);
  const layout = layOut(
    itemsFor(LATER_DAY, QUEUED, DRAFTS, LATER, TZ),
    DEFAULT_METRICS,
    columns,
  );
  const scroller = useScrollTo(openAt);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header title={LATER} />
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-24">
        <Timeline
          layout={layout}
          day={LATER}
          timezone={TZ}
          nowMinutes={14 * 60 + 25}
          bandWidth={bandWidth}
        />
      </div>
    </div>
  );
}

function TwoDays(): React.JSX.Element {
  const bandWidth = (window.innerWidth - TIMELINE_GUTTER) / 2;
  const columns = columnsFor(bandWidth, DEFAULT_METRICS);
  const left = layOut(itemsFor(EARLIER_DAY, [], [], EARLIER, TZ), DEFAULT_METRICS, columns);
  const right = layOut(itemsFor(LATER_DAY, QUEUED, DRAFTS, LATER, TZ), DEFAULT_METRICS, columns);
  const scroller = useScrollTo(openAt);
  const column = `calc((100% - ${TIMELINE_GUTTER}px) / 2)`;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header title={`${EARLIER} / ${LATER}`} />
      <div className="flex shrink-0 border-b border-line px-2 pb-1 text-center">
        <span className="shrink-0" style={{ width: `${TIMELINE_GUTTER}px` }} />
        <span className="font-numeric text-[11px] text-ink-faint" style={{ width: column }}>{EARLIER}</span>
        <span className="font-numeric text-[11px] text-ink" style={{ width: column }}>{LATER}</span>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-24">
        {left.allDay.length > 0 || right.allDay.length > 0 ? (
          <div className="mb-1 flex gap-1 border-b border-line px-2 py-1.5">
            <span className="shrink-0 pt-1 text-[10px] text-ink-dim" style={{ width: `${TIMELINE_GUTTER}px` }} />
            <AllDayBand
              items={left.allDay}
              timezone={TZ}
              metrics={DEFAULT_METRICS}
              bandWidth={bandWidth}
              label=""
            />
            <AllDayBand
              items={right.allDay}
              timezone={TZ}
              metrics={DEFAULT_METRICS}
              bandWidth={bandWidth}
              label=""
            />
          </div>
        ) : null}

        <div
          className="relative"
          style={{ height: `${minutesToPx(MINUTES_IN_DAY, DEFAULT_METRICS)}px` }}
        >
          <Hours metrics={DEFAULT_METRICS} />
          <div
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-line-soft"
            style={{ left: `calc(${TIMELINE_GUTTER}px + ${column})` }}
          />
          <DayBand
            layout={left}
            day={EARLIER}
            timezone={TZ}
            metrics={DEFAULT_METRICS}
            nowMinutes={null}
            bandWidth={bandWidth}
            style={{ left: `${TIMELINE_GUTTER}px`, width: column }}
          />
          <DayBand
            layout={right}
            day={LATER}
            timezone={TZ}
            metrics={DEFAULT_METRICS}
            nowMinutes={14 * 60 + 25}
            bandWidth={bandWidth}
            style={{ left: `calc(${TIMELINE_GUTTER}px + ${column})`, width: column }}
          />
        </div>
      </div>
    </div>
  );
}

const start = `/preview${params.get('open') === null ? '' : `?open=${params.get('open') ?? ''}`}`;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MemoryRouter initialEntries={[start]}>
      <div className="safe-area h-full">{twoDays ? <TwoDays /> : <OneDay />}</div>
    </MemoryRouter>
  </StrictMode>,
);
