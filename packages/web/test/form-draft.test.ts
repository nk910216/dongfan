import { beforeEach, describe, expect, it } from 'vitest';
import { clearForm, formKey, readForm, saveForm } from '../src/lib/form-draft.js';
import type { EventDraft } from '../src/components/EventFields.js';

/**
 * What somebody is part way through typing.
 *
 * A published app takes its updates by reloading, and the moment it is
 * most likely to be offered one is the moment it is being used. Losing a
 * half-filled feed to that is the thing spec 2.1 names outright, and it is
 * invisible from the inside: the page comes back looking perfectly fine,
 * empty.
 */

const SCOPE = 'user-1\u0000baby-1';
const NOON = 1_789_000_000_000;

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    startedAt: NOON,
    endedAt: null,
    displayValue: '150',
    note: '',
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());

describe('keeping what is being typed', () => {
  it('hands it back', () => {
    const key = formKey(SCOPE, 'add:bottle:');
    saveForm(key, 'record', draft());

    expect(readForm(key)?.draft.displayValue).toBe('150');
    expect(readForm(key)?.intent).toBe('record');
  });

  it('replaces only itself', () => {
    const bottle = formKey(SCOPE, 'add:bottle:');
    const sleep = formKey(SCOPE, 'add:sleep:');
    saveForm(bottle, 'record', draft());
    saveForm(sleep, 'start_timer', draft({ displayValue: '' }));
    saveForm(bottle, 'record', draft({ displayValue: '120' }));

    expect(readForm(bottle)?.draft.displayValue).toBe('120');
    expect(readForm(sleep)?.intent).toBe('start_timer');
  });

  it('keeps adding, correcting and editing apart', () => {
    // All three can be open for the same type, and each holds something
    // different: a new record, a queued one being fixed, a stored one.
    const add = formKey(SCOPE, 'add:bottle:');
    const correct = formKey(SCOPE, 'add:bottle:event-1');
    const edit = formKey(SCOPE, 'edit:event-2');

    saveForm(add, 'record', draft({ displayValue: '1' }));
    saveForm(correct, 'record', draft({ displayValue: '2' }));
    saveForm(edit, 'record', draft({ displayValue: '3' }));

    expect(readForm(add)?.draft.displayValue).toBe('1');
    expect(readForm(correct)?.draft.displayValue).toBe('2');
    expect(readForm(edit)?.draft.displayValue).toBe('3');
  });

  it('shows one account nothing of another', () => {
    const mine = formKey(SCOPE, 'add:bottle:');
    const theirs = formKey('other-parent\u0000other-baby', 'add:bottle:');
    saveForm(mine, 'record', draft());

    expect(readForm(theirs)).toBeNull();
  });

  it('forgets it once it has become something durable', () => {
    const key = formKey(SCOPE, 'add:bottle:');
    saveForm(key, 'record', draft());
    clearForm(key);

    expect(readForm(key)).toBeNull();
  });

  it('leaves the other forms alone when one is cleared', () => {
    const bottle = formKey(SCOPE, 'add:bottle:');
    const sleep = formKey(SCOPE, 'add:sleep:');
    saveForm(bottle, 'record', draft());
    saveForm(sleep, 'record', draft());

    clearForm(bottle);

    expect(readForm(sleep)).not.toBeNull();
  });
});

describe('when it is too old to be useful', () => {
  it('is not offered back', () => {
    const key = formKey(SCOPE, 'add:bottle:');
    saveForm(key, 'record', draft());

    // Next week. Filling in last week's amount against last week's start
    // time, silently, is worse than an empty form.
    const later = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(readForm(key, later)).toBeNull();
  });

  it('still is after an interruption of a few hours', () => {
    const key = formKey(SCOPE, 'add:bottle:');
    saveForm(key, 'record', draft());

    expect(readForm(key, Date.now() + 6 * 60 * 60 * 1000)).not.toBeNull();
  });
});

describe('storage that cannot be trusted', () => {
  it('survives a corrupt store', () => {
    localStorage.setItem('dongfan.form-drafts', 'not json');
    expect(readForm(formKey(SCOPE, 'add:bottle:'))).toBeNull();
  });

  it('drops entries that are not shaped like one', () => {
    localStorage.setItem('dongfan.form-drafts', JSON.stringify([{ nonsense: true }, 7]));
    expect(readForm(formKey(SCOPE, 'add:bottle:'))).toBeNull();
  });
});
