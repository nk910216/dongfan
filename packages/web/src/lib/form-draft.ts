import type { EventIntent } from '@dongfan/shared';
import type { EventDraft } from '../components/EventFields.js';

/**
 * What somebody is part way through typing.
 *
 * Reloading the page must not throw it away (spec 2.1). A published app
 * reloads to take an update, and the moment it is most likely to be
 * offered one is the moment it is being used -- so the half-filled bottle
 * form has to come back.
 *
 * Written as it is typed rather than saved on the way out. A reload asked
 * for by the update prompt is only one of the ways a page goes away; the
 * browser reclaiming a background tab is another, and it does not ask.
 *
 * This is not the offline queue and holds nothing the server may have.
 * Every one of these is re-typable by definition -- it has never been
 * sent -- which is why it can live in `localStorage` and be dropped when
 * it gets old without anything being lost.
 */

const KEY = 'dongfan.form-drafts';

/**
 * How long a draft is worth offering back.
 *
 * Long enough to survive a night shift and an interruption, short enough
 * that opening the bottle form next week does not silently fill in last
 * week's amount against a start time from last week.
 */
const KEEPS_FOR_MS = 12 * 60 * 60 * 1000;

export type SavedForm = {
  /** Account, baby, and which form: they must not see each other's. */
  key: string;
  intent: EventIntent;
  draft: EventDraft;
  savedAt: number;
};

/**
 * One form, named by everything that makes it a different form.
 *
 * `what` distinguishes adding a bottle from correcting a queued one from
 * editing a stored one, because all three can be open for the same type.
 */
export function formKey(scope: string, what: string): string {
  return `${scope}\u0000${what}`;
}

function readAll(): SavedForm[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedForm[]).filter(isSaved) : [];
  } catch {
    return [];
  }
}

function isSaved(value: unknown): value is SavedForm {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const draft = candidate['draft'];
  return (
    typeof candidate['key'] === 'string' &&
    typeof candidate['savedAt'] === 'number' &&
    typeof draft === 'object' &&
    draft !== null &&
    typeof (draft as Record<string, unknown>)['startedAt'] === 'number'
  );
}

function writeAll(forms: SavedForm[]): void {
  try {
    if (forms.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(forms));
  } catch {
    // Without storage the form still works for as long as the page is up,
    // which is the common case. Nothing that has been sent is at stake.
  }
}

export function saveForm(key: string, intent: EventIntent, draft: EventDraft): void {
  const others = readAll().filter((form) => form.key !== key);
  writeAll([...others, { key, intent, draft, savedAt: Date.now() }]);
}

/** What was being typed into that form, if it is still worth offering. */
export function readForm(key: string, now: number = Date.now()): SavedForm | null {
  const found = readAll().find((form) => form.key === key);
  if (!found) return null;
  return now - found.savedAt <= KEEPS_FOR_MS ? found : null;
}

/**
 * Forgets one form.
 *
 * Called when its contents have become something else -- a record on the
 * server, or an entry in the queue -- and not when the screen closes. A
 * screen closing is exactly the case this exists for.
 */
export function clearForm(key: string): void {
  const before = readAll();
  const after = before.filter((form) => form.key !== key);
  if (after.length !== before.length) writeAll(after);
}
