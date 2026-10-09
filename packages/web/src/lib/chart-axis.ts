import type { Aggregation, ValueSpec } from '@dongfan/shared';

/**
 * The value axis of a statistics chart (spec 7.7: dates along the bottom,
 * values up the side).
 *
 * The chart first had no value axis at all, only the highest value printed
 * in a corner -- so a bar's height meant nothing until it was compared with
 * that number by eye, and the unit was said once, far from the bars. Found
 * on a phone.
 *
 * **The unit depends on the type, and so does the arithmetic.** A count is
 * whole times; a bottle is millilitres; a temperature is stored in tenths
 * (365 is 36.5) and has to be ticked in degrees; a duration arrives in
 * minutes and reads in hours once there are enough of them. So ticks are
 * chosen in the unit a parent reads, and converted back to stored numbers
 * only to place them.
 *
 * **Where the axis starts depends on what is being claimed.** A bar's
 * length is its value, so bars always start at zero; so does anything
 * counted or added up, whose zero is a real day with nothing in it. A line
 * of readings -- weight, height, head size, temperature -- is about how
 * they change, and from zero a baby going from 7000 g to 7400 g is a flat
 * line and a fever is invisible. Those lines start near their lowest
 * reading instead, which the owner chose on condition that the screen says
 * so plainly (`bottom` is there for the caption).
 */

export type AxisUnit =
  | { kind: 'times' }
  | { kind: 'minutes' }
  | { kind: 'hours' }
  /** A configured unit symbol, rendered as it is: 'ml', 'g', 'mm', '°C'. */
  | { kind: 'symbol'; symbol: string };

export type Axis = {
  /** Tick values in stored units, upwards; the first is the bottom, the last the top. */
  ticks: number[];
  /** The bottom of the scale in stored units: zero unless the axis was allowed to lift. */
  bottom: number;
  /** The top of the scale in stored units, which is the last tick. */
  top: number;
  unit: AxisUnit;
  /** A tick as a parent reads it, without its unit or trailing zeros. */
  label: (stored: number) => string;
};

/** The steps a scale may move in, per power of ten. */
const NICE = [1, 2, 2.5, 5, 10];

/** Aims for about four intervals: enough to read, few enough to fit 130px. */
const INTERVALS = 4;

/**
 * A step of 1, 2, 2.5 or 5 times a power of ten that covers `highest` in
 * about four intervals. Whole numbers only when the quantity is, because
 * "2.5 times" is not something that happens.
 */
export function niceStep(highest: number, wholeOnly: boolean): number {
  if (highest <= 0) return 1;
  const raw = highest / INTERVALS;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = NICE.map((n) => n * magnitude).find((candidate) => candidate >= raw) ?? 10 * magnitude;
  if (!wholeOnly) return step;
  return Math.max(1, Math.ceil(step));
}

/** Enough decimals to tell two neighbouring ticks apart, and no more. */
function decimalsFor(step: number): number {
  for (let decimals = 0; decimals < 4; decimals += 1) {
    const scaled = step * 10 ** decimals;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return decimals;
  }
  return 4;
}

/**
 * Whether this chart may start above zero: a line, of readings rather than
 * of counts or totals. Bars never may.
 */
export function mayLift(aggregation: Aggregation, spec: ValueSpec | null, kind: 'bar' | 'line'): boolean {
  return kind === 'line' && spec !== null && ['last', 'max', 'avg'].includes(aggregation);
}

export function axisFor(
  aggregation: Aggregation,
  spec: ValueSpec | null,
  highest: number,
  /** Given, and `lift` true, the scale may start near here instead of at zero. */
  lift: { lowest: number } | null = null,
): Axis {
  // What one displayed unit is worth in stored units, and what it is called.
  let perUnit: number;
  let unit: AxisUnit;
  let wholeOnly: boolean;

  if (aggregation === 'duration_sum') {
    // Minutes until two hours, hours after: "480" minutes is a number to
    // divide in your head at 3am, and "0.5" hours is a worse way to say 30.
    const hours = highest >= 120;
    perUnit = hours ? 60 : 1;
    unit = hours ? { kind: 'hours' } : { kind: 'minutes' };
    wholeOnly = !hours;
  } else if (aggregation === 'count' || spec === null) {
    perUnit = 1;
    unit = { kind: 'times' };
    wholeOnly = true;
  } else {
    perUnit = spec.scale;
    unit = { kind: 'symbol', symbol: spec.unit };
    wholeOnly = false;
  }

  const hi = highest / perUnit;
  let base = 0;
  let step: number;
  if (lift !== null) {
    const lo = lift.lowest / perUnit;
    // A single reading, or several the same, has no spread to scale to;
    // a tenth of the value either side of it is enough to see it sit.
    const spread = hi - lo > 0 ? hi - lo : Math.max(hi * 0.1, 1);
    step = niceStep(spread, wholeOnly);
    base = Math.floor(lo / step + 1e-9) * step;
  } else {
    step = niceStep(hi, wholeOnly);
  }
  const intervals = Math.max(1, Math.ceil((hi - base) / step - 1e-9));
  const ticks = Array.from(
    { length: intervals + 1 },
    (_, i) => Math.round((base + i * step) * perUnit * 1e6) / 1e6,
  );
  const decimals = decimalsFor(step);

  return {
    ticks,
    bottom: ticks[0] ?? 0,
    top: ticks[ticks.length - 1] ?? perUnit,
    unit,
    // Rounded to the step's precision, then printed without trailing
    // zeros: "0, 0.5, 1, 1.5" rather than "0.0, 0.5, 1.0, 1.5".
    label: (stored) => String(Number((stored / perUnit).toFixed(decimals))),
  };
}
