import { axisLabel } from '../lib/stats-range.js';
import type { Range } from '../lib/stats-range.js';
import type { StatPointDto } from '@dongfan/shared';

/**
 * Bars or a line, drawn as SVG.
 *
 * Hand-drawn rather than pulled from a library. Two kinds of chart over at
 * most 366 points is a few dozen lines of geometry, and a charting library
 * is a large thing to ship to a phone on a home network for it -- the app
 * has to start with no connection at all (spec 6.2), and every kilobyte of
 * the shell is precached.
 *
 * `viewBox` with no width does the scaling, so the drawing has no idea how
 * wide the screen is and nothing has to be recomputed when it turns.
 */

const WIDTH = 320;
const HEIGHT = 130;
const PAD_LEFT = 4;
const PAD_BOTTOM = 16;

export function Chart({ points, kind, range, color, format }: {
  points: readonly StatPointDto[];
  kind: 'bar' | 'line';
  range: Range;
  color: string;
  /** Turns a stored integer into something readable, for the top label. */
  format: (value: number) => string;
}): React.JSX.Element | null {
  if (points.length === 0) return null;

  const highest = Math.max(...points.map((p) => p.value));
  // A flat run of zeros still needs a baseline to sit on rather than a
  // division by zero, and an all-zero chart is a real answer: nothing
  // happened.
  const top = highest === 0 ? 1 : highest;

  const plotHeight = HEIGHT - PAD_BOTTOM;
  const step = (WIDTH - PAD_LEFT) / points.length;
  const y = (value: number): number => plotHeight - (value / top) * (plotHeight - 4);

  /**
   * Points with no value are a gap in the line, not a zero.
   *
   * The server leaves a day out when zero would be a lie -- nobody weighed
   * the baby, which is not the same as the baby weighing nothing (spec 7.7).
   * Joining across the gap is exactly what that rule asks for.
   */
  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(PAD_LEFT + i * step + step / 2).toFixed(1)} ${y(p.value).toFixed(1)}`)
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
          ? points.map((point, i) => {
              const height = plotHeight - y(point.value);
              return (
                <rect
                  key={point.date}
                  x={PAD_LEFT + i * step + step * 0.15}
                  y={y(point.value)}
                  width={Math.max(step * 0.7, 0.6)}
                  height={Math.max(height, point.value > 0 ? 0.8 : 0)}
                  fill={color}
                  opacity={0.85}
                />
              );
            })
          : <path d={line} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />}

        {points.map((point, i) => {
          const label = axisLabel(range, point.date, i);
          if (label === null) return null;
          return (
            <text
              key={point.date}
              x={PAD_LEFT + i * step + step / 2}
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
