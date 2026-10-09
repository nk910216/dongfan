import type { EventTypeConfig, MetadataField } from './types.js';

/**
 * Metadata fields shared by more than one type.
 *
 * Enums are deliberately optional: a parent logging at 3am should never be
 * blocked by a required dropdown (spec 3.6). `title` is the exception,
 * because a milestone with no title is meaningless.
 */
const SIDE: MetadataField = {
  kind: 'enum',
  id: 'side',
  required: false,
  options: ['left', 'right', 'both'],
};

const DIAPER_KIND: MetadataField = {
  kind: 'enum',
  id: 'diaper_kind',
  required: false,
  options: ['pee', 'poo', 'both'],
};

const text = (id: string, maxLength: number, required = false): MetadataField => ({
  kind: 'text',
  id,
  required,
  maxLength,
});

/**
 * Every event type in v1 (spec 3.1.1).
 *
 * Ids are persisted, so they are never renamed or reused. Display names are
 * resolved from i18n by id.
 */
export const EVENT_TYPES: readonly EventTypeConfig[] = [
  // Food
  {
    id: 'nursing',
    category: 'food',
    icon: 'heart',
    color: '#74D39A',
    // The quantity here is elapsed time, not a number the parent types, so
    // there is no value spec and the aggregation works off the range.
    hasRange: true,
    timerEnabled: true,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'duration_sum',
    quickAction: true,
    order: 1,
    metadataFields: [SIDE],
  },
  {
    id: 'bottle',
    category: 'food',
    icon: 'milk',
    color: '#5FC9B0',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: { unit: 'ml', scale: 1, min: 0, max: 500 },
    valueRequired: true,
    aggregation: 'sum',
    quickAction: true,
    order: 2,
  },
  {
    id: 'solid_food',
    category: 'food',
    icon: 'utensils',
    color: '#9BD46E',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: true,
    order: 3,
    metadataFields: [text('food_name', 50)],
  },
  {
    id: 'pumping',
    category: 'food',
    icon: 'droplets',
    color: '#4FB89A',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: { unit: 'ml', scale: 1, min: 0, max: 500 },
    valueRequired: true,
    aggregation: 'sum',
    quickAction: false,
    order: 4,
    metadataFields: [SIDE],
  },

  // Activity
  {
    id: 'diaper',
    category: 'activity',
    icon: 'baby',
    color: '#E8B15C',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: true,
    order: 1,
    metadataFields: [DIAPER_KIND],
  },
  {
    id: 'sleep',
    category: 'activity',
    icon: 'moon',
    color: '#8B9DF0',
    hasRange: true,
    timerEnabled: true,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'duration_sum',
    quickAction: true,
    order: 2,
  },
  {
    id: 'walk',
    category: 'activity',
    icon: 'footprints',
    color: '#7FB3E8',
    hasRange: true,
    timerEnabled: true,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'duration_sum',
    quickAction: false,
    order: 3,
  },
  {
    id: 'bath',
    category: 'activity',
    icon: 'shower-head',
    color: '#6FC7D9',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 4,
  },
  {
    id: 'play',
    category: 'activity',
    icon: 'blocks',
    color: '#A3A8F5',
    hasRange: true,
    timerEnabled: true,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'duration_sum',
    quickAction: false,
    order: 5,
  },

  // Growth
  {
    id: 'weight',
    category: 'growth',
    icon: 'scale',
    color: '#F08A8A',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: { unit: 'g', scale: 1, min: 500, max: 30000 },
    valueRequired: true,
    // Summing weights would be nonsense; the day's figure is its last reading.
    aggregation: 'last',
    quickAction: false,
    order: 1,
  },
  {
    id: 'height',
    category: 'growth',
    icon: 'ruler',
    color: '#EF7B9E',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: { unit: 'mm', scale: 1, min: 200, max: 1500 },
    valueRequired: true,
    aggregation: 'last',
    quickAction: false,
    order: 2,
  },
  {
    id: 'head_circ',
    category: 'growth',
    icon: 'circle-dashed',
    color: '#E88AB8',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: { unit: 'mm', scale: 1, min: 200, max: 700 },
    valueRequired: true,
    aggregation: 'last',
    quickAction: false,
    order: 3,
  },

  // Health
  {
    id: 'doctor_visit',
    category: 'health',
    icon: 'stethoscope',
    color: '#5BC8C0',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 1,
    metadataFields: [text('place', 50), text('reason', 100)],
  },
  {
    id: 'vaccine',
    category: 'health',
    icon: 'syringe',
    color: '#57BDD4',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 2,
    metadataFields: [text('vaccine_name', 50)],
  },
  {
    id: 'temperature',
    category: 'health',
    icon: 'thermometer',
    color: '#5FC4CE',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    // Stored in tenths of a degree, so 36.5 C is the integer 365.
    value: { unit: '°C', scale: 10, min: 34, max: 42 },
    valueRequired: true,
    aggregation: 'max',
    quickAction: false,
    order: 3,
  },
  {
    id: 'illness',
    category: 'health',
    icon: 'bandage',
    color: '#4FB9B2',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 4,
    metadataFields: [text('illness_name', 50)],
  },
  {
    id: 'medicine',
    category: 'health',
    icon: 'pill',
    color: '#6BD0BE',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 5,
    metadataFields: [text('medicine_name', 50)],
  },

  // Mood
  { id: 'mood_happy', category: 'mood', icon: 'smile', color: '#C58BE8', hasRange: false, timerEnabled: false, allDay: false, value: null, valueRequired: false, aggregation: 'count', quickAction: false, order: 1 },
  { id: 'mood_neutral', category: 'mood', icon: 'meh', color: '#B39AD9', hasRange: false, timerEnabled: false, allDay: false, value: null, valueRequired: false, aggregation: 'count', quickAction: false, order: 2 },
  { id: 'mood_sad', category: 'mood', icon: 'frown', color: '#9B8BD9', hasRange: false, timerEnabled: false, allDay: false, value: null, valueRequired: false, aggregation: 'count', quickAction: false, order: 3 },
  { id: 'mood_crying', category: 'mood', icon: 'cloud-rain', color: '#D18BD0', hasRange: false, timerEnabled: false, allDay: false, value: null, valueRequired: false, aggregation: 'count', quickAction: false, order: 4 },

  // Milestone and other
  {
    id: 'milestone',
    category: 'milestone',
    icon: 'star',
    color: '#E8C55C',
    hasRange: false,
    timerEnabled: false,
    allDay: true,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 1,
    metadataFields: [text('title', 100, true)],
  },
  {
    id: 'other',
    category: 'other',
    icon: 'circle-ellipsis',
    color: '#9A9086',
    hasRange: false,
    timerEnabled: false,
    allDay: false,
    value: null,
    valueRequired: false,
    aggregation: 'count',
    quickAction: false,
    order: 1,
    metadataFields: [text('title', 100, true)],
  },
] as const;

const BY_ID = new Map(EVENT_TYPES.map((t) => [t.id, t]));

/** Returns undefined for an unknown id; callers render a fallback (spec 3.1). */
export function getEventType(id: string): EventTypeConfig | undefined {
  return BY_ID.get(id);
}

export function eventTypesInCategory(category: string): EventTypeConfig[] {
  return EVENT_TYPES.filter((t) => t.category === category).sort((a, b) => a.order - b.order);
}

export function quickActionTypes(): EventTypeConfig[] {
  return EVENT_TYPES.filter((t) => t.quickAction).sort((a, b) => a.order - b.order);
}
