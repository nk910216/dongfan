import { axisLabel, dayIndex, daysOf } from '../lib/stats-range.js';
import type { Range } from '../lib/stats-range.js';
import type { StatPointDto } from '@dongfan/shared';

/**
 * Bars or a line, drawn as SVG.
 *
 * Hand-drawn rather than pulled from a library. Two kinds of chart over at
 * most 366 points is a few dozen lines of geometry, and a charting library is
 * a large thing to precache for a phone that has to start with no connection
 * at all (spec 6.2).
 *
 * **Position comes from the date, never from the position in the array.** For
 * anything that is not zero-filled -- weight, temperature (spec 7.7) -- the
 * points are irregular: three weighings on the 1st, the 2nd and the 30th are
 * three points, and spacing them evenly draws a month of steady growth that
 * did not happen. The axis is the range, and a value sits where its day is.
 *
 * `viewBox` with no width does the scaling, so the drawing has no idea how
 * wide the screen is and nothing is recomputed when the phone turns.
 */

const WIDTH = 320;
const HEIGHT = 130;
const PAD_LEFT = 4;
const PAD_BOTTOM = 16;

export function Chart({ points, range, start, kind, color, format }: {
  points: readonly StatPointDto[];
  range: Range;
  /** The first day of the window; the axis runs from here. */
  start: string;
  kind: 'bar' | 'line';
  color: string;
  /** Turns a stored integer into something readable, for the top label. */
  format: (value: number) => string;
}): React.JSX.Element | null {
  const days = daysOf(range, start);
  if (points.length === 0 || days.length === 0) return null;

  const highest = Math.max(...points.map((p) => p.value));
  // A flat run of zeros still needs a baseline to sit on rather than a
  // division by zero, and an all-zero chart is a real answer: nothing
  // happened.
  const top = highest === 0 ? 1 : highest;

  const plotHeight = HEIGHT - PAD_BOTTOM;
  const step = (WIDTH - PAD_LEFT) / days.length;
  const x = (date: string): number => PAD_LEFT + (dayIndex(start, date) + 0.5) * step;
  const y = (value: number): number => plotHeight - (value / top) * (plotHeight - 4);

  const plotted = points.map((point) => ({ point, cx: x(point.date), cy: y(point.value) }));

  /**
   * Gaps are joined, because that is what the missing days mean.
   *
   * The server leaves a day out when zero would be a lie -- nobody weighed
   * the baby, which is not the same as the baby weighing nothing (spec 7.7)
   * -- so the line runs straight from one reading to the next.
   */
  const path = plotted
    .map(({ cx, cy }, i) => `${i === 0 ? 'M' : 'L'} ${cx.toFixed(1)} ${cy.toFixed(1)}`)
    .join(' ');

  return (
    <div className="mx-3.5 rounded-2xl border border-line bg-surface px-2 pt-2 pb-1">
      <div className="mb-1 px-2 text-right font-numeric text-[11px] text-ink-faint">
        {format(highest)}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        data-testid={`chart-${kind}`}
        aria-label={`${points.length}`}
      >
        <line x1={PAD_LEFT} y1={plotHeight} x2={WIDTH} y2={plotHeight} stroke="#2e2921" strokeWidth={1} />

        {kind === 'bar'
          ? plotted.map(({ point, cy }) => (
              <rect
                key={point.date}
                x={x(point.date) - Math.max(step * 0.35, 0.3)}
                y={cy}
                width={Math.max(step * 0.7, 0.6)}
                height={Math.max(plotHeight - cy, point.value > 0 ? 0.8 : 0)}
                fill={color}
                opacity={0.85}
              />
            ))
          : (
            <>
              {plotted.length > 1 ? (
                <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
              ) : null}
              {/* Drawn for few enough readings to see them, and always when
                  there is one: a path of a single point has no line in it and
                  would leave the chart looking empty. */}
              {plotted.length <= 40
                ? plotted.map(({ point, cx, cy }) => (
                    <circle key={point.date} cx={cx} cy={cy} r={1.8} fill={color} />
                  ))
                : null}
            </>
          )}

        {days.map((date, i) => {
          const label = axisLabel(range, date, i);
          if (label === null) return null;
          return (
            <text
              key={date}
              x={x(date)}
              y={HEIGHT - 4}
              textAnchor="middle"
              fill="#776e62"
              fontSize={9}
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
