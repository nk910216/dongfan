import { MAX_EVENT_DURATION_MS, addLocalDays, toLocalDate } from './datetime.js';
import type { LocalDate } from './datetime.js';
import { MAX_FUTURE_DAYS, MAX_NOTE_LENGTH } from './constants.js';
import { isWithinRange, toDisplayed } from './value.js';
import type { FieldError } from './errors.js';
import type { EventIntent, EventTypeConfig, MetadataField } from './types.js';

/**
 * The rules an event has to satisfy, in one place.
 *
 * The event type config drives both sides (spec 3.6): the web layer renders
 * inputs from it and the API validates against it. Writing the checks twice
 * is how a form starts accepting something the server refuses, so both call
 * this.
 *
 * Everything here works in stored units. Conversion from what a parent typed
 * happens in the input layer (spec 5.3).
 */

export type EventValidationInput = {
  readonly intent: EventIntent;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly value?: number | undefined;
  readonly note?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
};

export type EventValidationContext = {
  readonly now: number;
  readonly timeZone: string;
  readonly birthDate: LocalDate;
};

/** Length in characters. A parent's emoji is one character, not two. */
function characters(value: string): number {
  return [...value].length;
}

const MAX_DURATION_HOURS = MAX_EVENT_DURATION_MS / 3_600_000;

function checkTimes(
  type: EventTypeConfig,
  input: EventValidationInput,
  ctx: EventValidationContext,
  errors: FieldError[],
): void {
  const latest = addLocalDays(toLocalDate(ctx.now, ctx.timeZone), MAX_FUTURE_DAYS);
  const earliest = addLocalDays(ctx.birthDate, -1);

  // A local date comparison rather than a millisecond one: "no more than a
  // day ahead" is a claim about calendar days in the baby's timezone, and
  // the parent reading the error is looking at a date, not an instant.
  const startedOn = toLocalDate(input.startedAt, ctx.timeZone);
  if (startedOn > latest) {
    errors.push({ field: 'startedAt', code: 'TOO_FAR_IN_FUTURE', params: { maxDays: MAX_FUTURE_DAYS } });
  }
  if (startedOn < earliest) {
    errors.push({ field: 'startedAt', code: 'BEFORE_BIRTH', params: {} });
  }

  if (input.endedAt === null) return;

  // An end time on a type that has no range, or on something being started
  // right now, is not a value to silently drop: the client meant something
  // this endpoint cannot express.
  if (!type.hasRange || type.allDay) {
    errors.push({ field: 'endedAt', code: 'UNKNOWN_FIELD', params: {} });
    return;
  }
  if (type.timerEnabled && input.intent === 'start_timer') {
    errors.push({ field: 'endedAt', code: 'UNKNOWN_FIELD', params: {} });
    return;
  }

  if (input.endedAt < input.startedAt) {
    errors.push({ field: 'endedAt', code: 'END_BEFORE_START', params: {} });
    return;
  }
  // The 24 hour ceiling is what guarantees an event crosses midnight at most
  // once, which is what keeps the splitting logic simple (spec 3.4.1).
  if (input.endedAt - input.startedAt > MAX_EVENT_DURATION_MS) {
    errors.push({ field: 'endedAt', code: 'DURATION_TOO_LONG', params: { maxHours: MAX_DURATION_HOURS } });
  }
  if (toLocalDate(input.endedAt, ctx.timeZone) > latest) {
    errors.push({ field: 'endedAt', code: 'TOO_FAR_IN_FUTURE', params: { maxDays: MAX_FUTURE_DAYS } });
  }
}

function checkValue(type: EventTypeConfig, input: EventValidationInput, errors: FieldError[]): void {
  const spec = type.value;

  if (spec === null) {
    // The column defaults to 1 for types that do not carry a number, so that
    // one value is accepted and anything else is a client that thinks this
    // type has a quantity.
    if (input.value !== undefined && input.value !== 1) {
      errors.push({ field: 'value', code: 'UNKNOWN_FIELD', params: {} });
    }
    return;
  }

  if (input.value === undefined) {
    if (type.valueRequired) errors.push({ field: 'value', code: 'REQUIRED', params: {} });
    return;
  }

  if (!Number.isInteger(input.value)) {
    errors.push({ field: 'value', code: 'NOT_INTEGER', params: {} });
    return;
  }

  // Bounds are expressed in displayed units, and so is the message: telling
  // a parent that 3650 is out of range when they typed 36.5 helps nobody.
  if (!isWithinRange(toDisplayed(input.value, spec), spec)) {
    errors.push({ field: 'value', code: 'OUT_OF_RANGE', params: { min: spec.min, max: spec.max } });
  }
}

function checkMetadataField(field: MetadataField, raw: string, errors: FieldError[]): void {
  const path = `metadata.${field.id}`;

  if (field.kind === 'enum') {
    if (!field.options.includes(raw)) {
      errors.push({ field: path, code: 'INVALID_ENUM', params: { allowed: field.options.join(',') } });
    }
    return;
  }

  if (field.kind === 'text') {
    if (characters(raw) > field.maxLength) {
      errors.push({ field: path, code: 'TOO_LONG', params: { maxLength: field.maxLength } });
    }
    return;
  }

  const parsed = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(parsed)) {
    errors.push({ field: path, code: 'INVALID_FORMAT', params: {} });
    return;
  }
  if (!Number.isInteger(parsed)) {
    errors.push({ field: path, code: 'NOT_INTEGER', params: {} });
    return;
  }
  if (parsed < field.min || parsed > field.max) {
    errors.push({ field: path, code: 'OUT_OF_RANGE', params: { min: field.min, max: field.max } });
  }
}

function checkMetadata(type: EventTypeConfig, input: EventValidationInput, errors: FieldError[]): void {
  const defined = type.metadataFields ?? [];
  const metadata = input.metadata ?? {};

  // Keys the config does not define are rejected rather than stored as given
  // (spec 3.6). Accepting them would let anything at all accumulate in the
  // column, and nothing would ever read it back.
  for (const key of Object.keys(metadata)) {
    if (!defined.some((field) => field.id === key)) {
      errors.push({ field: `metadata.${key}`, code: 'UNKNOWN_FIELD', params: {} });
    }
  }

  for (const field of defined) {
    const raw = metadata[field.id];
    // An empty string means the parent skipped an optional field, which is
    // the same as not sending it. Only `title` is required (spec 3.6).
    if (raw === undefined || raw === '') {
      if (field.required) errors.push({ field: `metadata.${field.id}`, code: 'REQUIRED', params: {} });
      continue;
    }
    checkMetadataField(field, raw, errors);
  }
}

/**
 * Validates an event against its type, returning every problem at once.
 *
 * All of them, not the first: a form that reports one error per submission
 * makes a parent tap save five times at three in the morning.
 */
export function validateEvent(
  type: EventTypeConfig,
  input: EventValidationInput,
  ctx: EventValidationContext,
): FieldError[] {
  const errors: FieldError[] = [];

  if (input.intent === 'start_timer' && !type.timerEnabled) {
    errors.push({ field: 'intent', code: 'INVALID_ENUM', params: { allowed: 'record' } });
  }

  if (input.note !== undefined && characters(input.note) > MAX_NOTE_LENGTH) {
    errors.push({ field: 'note', code: 'TOO_LONG', params: { maxLength: MAX_NOTE_LENGTH } });
  }

  checkTimes(type, input, ctx, errors);
  checkValue(type, input, errors);
  checkMetadata(type, input, errors);

  return errors;
}
