import type { EventIntent } from '@dongfan/shared';
import type { EventDraft } from '../components/EventFields.js';
import { getQueued, hasEvent } from './db.js';

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
  /**
   * The version of the event these changes were made on top of.
   *
   * Only on an edit, and the reason it exists is the optimistic lock. The
   * fields here are the ones from *that* version, so saving them against
   * whatever version turns up after a reload would write this device's
   * idea of every field over somebody else's change -- and the server
   * would accept it, because the version it was handed was current. The
   * conflict that should have been reported never happens (spec 6.3).
   *
   * Carried back out and sent, so a stale draft collects the 409 it
   * deserves and the parent is told, instead of being told nothing.
   */
  baseVersion?: number;
  /**
   * The id this content was being handed to the queue under.
   *
   * Written just before the hand-over, which means it says *handing
   * over*, not *handed over*: the write that puts it in the queue can
   * still fail, and the page can still go away before that write commits.
   * Treating it as done would exclude the draft from ever being offered
   * back while nothing anywhere held the content -- the typing simply
   * gone.
   *
   * So it is settled afterwards, by `reconcileForms`, against the only
   * two places the content could have got to. What it buys in the
   * meantime is the id itself: a draft offered back keeps it, so
   * resending cannot become a second record however the race turned out
   * (spec 3.8).
   */
  eventId?: string;
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

export function saveForm(
  key: string,
  intent: EventIntent,
  draft: EventDraft,
  marks: { baseVersion?: number; eventId?: string } = {},
): void {
  const others = readAll().filter((form) => form.key !== key);
  writeAll([...others, { key, intent, draft, savedAt: Date.now(), ...marks }]);
}

/** What was being typed into that form, if it is still worth offering. */
export function readForm(key: string, now: number = Date.now()): SavedForm | null {
  const found = readAll().find((form) => form.key === key);
  if (!found) return null;
  if (now - found.savedAt > KEEPS_FOR_MS) return null;

  // A draft written before tags were a field has none. Completed here, once,
  // rather than at each of the three screens that read one back: a missing
  // field read as an empty list is the kind of difference that silently
  // strips something, and it should be impossible to forget.
  // `found.draft` is typed as complete and may not be, which is the whole
  // point of this line.
  const draft = found.draft as Partial<EventDraft>;
  return { ...found, draft: { ...found.draft, tagIds: draft.tagIds ?? [] } };
}

/**
 * Moves a draft to another key, keeping everything about it.
 *
 * For a draft that has to be held on to but must not sit where the live
 * form writes: the two are different things and sharing a key makes every
 * keystroke overwrite one of them, and any clearing of one delete the
 * other. `savedAt` travels with it, so being moved does not make an old
 * draft young again.
 *
 * Refuses to write over something already parked there. The first one is
 * the one somebody wrote; a second move would be this screen opening
 * twice.
 */
export function moveForm(from: string, to: string): void {
  const forms = readAll();
  const found = forms.find((form) => form.key === from);
  if (!found || forms.some((form) => form.key === to)) return;

  writeAll([
    ...forms.filter((form) => form.key !== from && form.key !== to),
    { ...found, key: to },
  ]);
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

/**
 * Settles every draft that was part way through being handed over.
 *
 * Run before any screen reads one, because the question it answers cannot
 * be answered from `localStorage`: did the content reach the queue?
 *
 * - In the queue: the queue is the durable copy now, and offering the
 *   draft back would be a second one. Dropped.
 * - Known to this device as an event: it was sent, or sent and deleted.
 *   Dropped, for the same reason.
 * - Neither: the hand-over never completed -- the write failed, or the
 *   page went away before it committed. It is still a draft, and it keeps
 *   its id so that sending it cannot duplicate anything.
 *
 * The third case is the one this exists for. It was previously treated as
 * the first, and the typing was gone.
 */
export async function reconcileForms(scope: string): Promise<void> {
  const prefix = `${scope}\u0000`;
  const pending = readAll().filter(
    (form) => form.eventId !== undefined && form.key.startsWith(prefix),
  );

  for (const form of pending) {
    const eventId = form.eventId as string;
    if ((await getQueued(scope, eventId)) || (await hasEvent(scope, eventId))) {
      clearForm(form.key);
    }
  }
}
