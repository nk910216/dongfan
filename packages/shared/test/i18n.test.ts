import { describe, expect, it, vi } from 'vitest';
import { errorMessage, eventTypeName, fieldErrorMessage, interpolate, metadataOptionLabel } from '../src/i18n/index.js';
import { EVENT_TYPES } from '../src/event-types.js';
import { zhTW } from '../src/i18n/zh-TW.js';
import { USER_CONTENT } from './fixtures/user-content.js';

describe('copy coverage', () => {
  it('names every shipped event type', () => {
    const names: Record<string, string> = zhTW.eventType;
    for (const type of EVENT_TYPES) {
      expect(names[type.id], `missing copy for ${type.id}`).toBeTruthy();
    }
  });

  it('labels every metadata field and enum option', () => {
    const labels: Record<string, string> = zhTW.metadata;
    for (const type of EVENT_TYPES) {
      for (const field of type.metadataFields ?? []) {
        expect(labels[field.id], `missing label for ${field.id}`).toBeTruthy();
        if (field.kind === 'enum') {
          for (const option of field.options) {
            expect(labels[`${field.id}.${option}`], `missing option copy for ${field.id}.${option}`).toBeTruthy();
          }
        }
      }
    }
  });
});

describe('unknown codes', () => {
  it('falls back rather than showing a raw error code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(errorMessage('SOMETHING_NEW')).toBe(zhTW.error.UNKNOWN);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SOMETHING_NEW'));
    warn.mockRestore();
  });

  it('falls back for an unrecognised field error code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(fieldErrorMessage({ field: 'value', code: 'NOPE' as never, params: {} })).toBe(zhTW.fieldError.UNKNOWN);
    warn.mockRestore();
  });

  it('names an unknown event type without throwing', () => {
    expect(eventTypeName('retired_type')).toBe(zhTW.eventType.unknown);
  });
});

describe('interpolation', () => {
  it('substitutes params into field error copy', () => {
    expect(fieldErrorMessage({ field: 'value', code: 'OUT_OF_RANGE', params: { min: 0, max: 500 } }))
      .toContain('500');
  });

  it('leaves an unknown placeholder visible instead of printing undefined', () => {
    expect(interpolate('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('resolves enum option copy', () => {
    expect(metadataOptionLabel('diaper_kind', 'both')).toBe(zhTW.metadata['diaper_kind.both']);
    expect(metadataOptionLabel('diaper_kind', 'unmapped')).toBe('unmapped');
  });
});

describe('user content is data, not code', () => {
  it('counts length in characters, not bytes', () => {
    // Thirty bytes in UTF-8, but a ten character limit must accept it.
    expect(USER_CONTENT.tenCharacters.length).toBe(10);
    expect(new TextEncoder().encode(USER_CONTENT.tenCharacters).length).toBe(30);
  });

  it('keeps nicknames, notes and tags exactly as typed', () => {
    for (const value of [USER_CONTENT.babyNickname, USER_CONTENT.note, USER_CONTENT.noteWithEmoji, ...USER_CONTENT.tagNames]) {
      expect(structuredClone(value)).toBe(value);
      expect(value.normalize('NFC')).toBe(value);
    }
  });
});
