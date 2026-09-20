import { zhTW } from './zh-TW.js';
import { isKnownErrorCode, isKnownFieldErrorCode } from '../errors.js';
import type { ErrorParams, FieldError } from '../errors.js';

export { zhTW };

/** Replaces `{name}` placeholders. Missing keys are left in place, visibly. */
export function interpolate(template: string, params: ErrorParams = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolves a top-level error code to copy.
 *
 * Unknown codes fall back rather than surfacing a raw constant: a published
 * PWA updates later than its backend, so meeting a code this build has never
 * heard of is a matter of when, not if (spec 5.2).
 */
export function errorMessage(code: string): string {
  if (isKnownErrorCode(code)) return zhTW.error[code];
  console.warn(`Unrecognised error code from API: ${code}`);
  return zhTW.error.UNKNOWN;
}

export function fieldErrorMessage(error: FieldError): string {
  if (isKnownFieldErrorCode(error.code)) {
    return interpolate(zhTW.fieldError[error.code], error.params);
  }
  console.warn(`Unrecognised field error code from API: ${error.code}`);
  return zhTW.fieldError.UNKNOWN;
}

/** Display name for an event type; unknown ids render a neutral label. */
export function eventTypeName(id: string): string {
  const names: Record<string, string> = zhTW.eventType;
  return names[id] ?? zhTW.eventType.unknown;
}

export function categoryName(id: string): string {
  const names: Record<string, string> = zhTW.category;
  return names[id] ?? id;
}

/**
 * Label for a type's numeric input.
 *
 * Falls back to the type's own name rather than its id, so a new type with
 * no dedicated label still reads as Chinese instead of leaking an
 * identifier into the interface.
 */
export function valueLabel(typeId: string): string {
  const labels: Record<string, string> = zhTW.valueLabel;
  return labels[typeId] ?? eventTypeName(typeId);
}

export function metadataLabel(fieldId: string): string {
  const labels: Record<string, string> = zhTW.metadata;
  return labels[fieldId] ?? fieldId;
}

export function metadataOptionLabel(fieldId: string, value: string): string {
  const labels: Record<string, string> = zhTW.metadata;
  return labels[`${fieldId}.${value}`] ?? value;
}
