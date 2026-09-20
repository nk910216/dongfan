import type { EventPageDto, SummaryDto } from '@dongfan/shared';
import { applyPage, readMeta, writeSummary } from './db.js';
import type { Scope } from './db.js';

/**
 * Pulling changes from the server into the local database.
 *
 * The cursor is a `rev` the server issued, never a timestamp. A timestamp
 * cursor loses any write that shares its second with one already seen, and
 * loses it permanently: the query asks for something greater, and there is
 * nothing greater to find (spec 5.4).
 */

/** What the caller needs to make one request. */
export type Fetcher = <T>(path: string) => Promise<T>;

const PAGE = 200;

/**
 * How many pages one call will pull before giving up.
 *
 * A guard against a server that keeps saying `has_more` -- a bug in
 * pagination would otherwise spin here forever, in a loop nothing
 * interrupts. Two hundred thousand events is far beyond anything this app
 * can hold (spec 2.5), so reaching this is a fault, not a busy family.
 */
const MAX_PAGES = 1000;

export type SyncResult = {
  /** Rows actually written. Lower than the number received when a page repeats. */
  applied: number;
  cursor: number;
};

/**
 * Pulls everything newer than the stored cursor.
 *
 * Each page is committed with the cursor that page ends at, rather than
 * holding them all until the end. Committing per page means an interrupted
 * sync resumes where it stopped instead of starting over; holding them
 * would mean a long first sync on a bad connection never finishing at all.
 * What must not happen -- rows landing without the cursor, or the cursor
 * moving without the rows -- is prevented by the two being one transaction
 * (spec 6.2), not by leaving both to the end.
 *
 * It keeps going until the server says there is no more, which is the part
 * spec 5.4 insists on: stopping at a full page would leave the rest
 * unasked for until something else happened to trigger a sync.
 */
export async function syncEvents(
  scope: Scope,
  babyId: string,
  fetch: Fetcher,
): Promise<SyncResult> {
  let cursor = (await readMeta(scope)).cursor;
  let applied = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await fetch<EventPageDto>(
      `/babies/${babyId}/events?since=${cursor}&limit=${PAGE}`,
    );

    applied += await applyPage(scope, body.events, body.nextRev);
    cursor = body.nextRev;

    if (!body.hasMore) return { applied, cursor };
  }

  throw new Error('Sync did not finish; the server kept reporting more pages');
}

/**
 * Fetches the summary and keeps a copy.
 *
 * Always from the server. What changes when an event moves is not something
 * a client can work out -- a sleep that began last night alters today's
 * figures too, and a corrected timestamp alters two days at once
 * (spec 6.2). The copy is for showing something while offline, marked as
 * old rather than presented as current (spec 5.5).
 */
export async function syncSummary(
  scope: Scope,
  babyId: string,
  fetch: Fetcher,
): Promise<SummaryDto> {
  const summary = await fetch<SummaryDto>(`/babies/${babyId}/events/summary`);
  await writeSummary(scope, summary);
  return summary;
}
