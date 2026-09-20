import type { ValueSpec } from './types.js';

/**
 * Conversion between what a parent types and what the database holds.
 *
 * Everything below the input layer works in stored integers: the API sends
 * and receives 365, never 36.5 (spec 5.3). Keeping the conversion in one
 * place is what stops a display value reaching the database.
 */

export function toStored(displayed: number, spec: ValueSpec): number {
  return Math.round(displayed * spec.scale);
}

export function toDisplayed(stored: number, spec: ValueSpec): number {
  return stored / spec.scale;
}

/** Formats a stored value for display, without its unit. */
export function formatValue(stored: number, spec: ValueSpec): string {
  const displayed = toDisplayed(stored, spec);
  const decimals = Math.max(0, Math.round(Math.log10(spec.scale)));
  return displayed.toFixed(decimals);
}

export function isWithinRange(displayed: number, spec: ValueSpec): boolean {
  return displayed >= spec.min && displayed <= spec.max;
}
