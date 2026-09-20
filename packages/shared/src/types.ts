/**
 * Structural definitions for event types.
 *
 * These describe shape and constraints only. No display text lives here:
 * the config is loaded by the backend for validation, so interface copy
 * belongs in i18n/zh-TW.ts instead (spec 13.1).
 */

export const CATEGORY_IDS = [
  'food',
  'activity',
  'growth',
  'health',
  'mood',
  'milestone',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** How the statistics page rolls a type up into one number per day (spec 7.7). */
export type Aggregation =
  | 'count'
  | 'sum'
  | 'last'
  | 'avg'
  | 'max'
  | 'duration_sum';

/**
 * A numeric field on an event.
 *
 * Values are stored as integers in the smallest unit to avoid float drift:
 * stored = displayed * scale. A temperature of 36.5 C is stored as 365
 * with scale 10 (spec 3.2).
 */
export type ValueSpec = {
  /** Unit symbol, safe to render as-is: 'ml', 'g', 'mm', 'C'. */
  readonly unit: string;
  readonly scale: number;
  /** Bounds expressed in displayed units, not stored units. */
  readonly min: number;
  readonly max: number;
};

/**
 * An extra per-type field, serialised into the event's metadata JSON.
 *
 * One definition drives both sides: the web layer renders an input from it
 * and the API derives its Zod schema from it (spec 3.6). Labels and option
 * text come from i18n, keyed by field id and `<id>.<value>`.
 */
export type MetadataField =
  | { readonly kind: 'enum'; readonly id: string; readonly required: boolean; readonly options: readonly string[] }
  | { readonly kind: 'text'; readonly id: string; readonly required: boolean; readonly maxLength: number }
  | { readonly kind: 'number'; readonly id: string; readonly required: boolean; readonly min: number; readonly max: number; readonly unit?: string };

export type EventTypeConfig = {
  /** Stored in the database; never rename or reuse. */
  readonly id: string;
  readonly category: CategoryId;
  /** lucide-react icon name. */
  readonly icon: string;
  /** Accent colour as a CSS hex string. */
  readonly color: string;
  readonly hasRange: boolean;
  /** Can be started now and stopped later, holding the single active slot. */
  readonly timerEnabled: boolean;
  readonly allDay: boolean;
  readonly value: ValueSpec | null;
  readonly valueRequired: boolean;
  readonly aggregation: Aggregation;
  /** Shown in the quick action strip on the home screen. */
  readonly quickAction: boolean;
  /** Display order within its category; must be unique per category. */
  readonly order: number;
  readonly metadataFields?: readonly MetadataField[];
};

/**
 * Whether a new event starts a timer or records something already finished.
 *
 * Both carry the same fields, so the intent has to be explicit: only
 * `start_timer` sets the active flag and takes the type's single active
 * slot (spec 3.5).
 */
export type EventIntent = 'start_timer' | 'record';
