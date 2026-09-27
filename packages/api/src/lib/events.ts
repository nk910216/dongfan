import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { eventTags, events, tags } from '../db/schema.js';
import type { EventDto, EventPageDto } from '@dongfan/shared';
import type { Env } from './types.js';

/**
 * Reading and shaping events.
 *
 * Writes do not live here: they go through raw batched statements so the
 * version guard can be a predicate on every one of them (spec 4.3), which
 * the query builder cannot express.
 */

/**
 * The only way a rev is allocated (spec 5.4, rule 3).
 *
 * Its single bound parameter is the baby id, supplied at whatever position
 * the fragment occupies in the surrounding statement. Every insert, update,
 * soft delete and batch tag update uses this and nothing else: a second
 * spelling somewhere is how two rows end up sharing a rev, and a shared rev
 * makes pagination drop data silently.
 */
export const NEXT_REV = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM events WHERE baby_id = ?)';

/**
 * The same allocation for a batch: **one rev per row, in one statement**.
 *
 * Renaming or deleting a tag moves every event carrying it, and spec 5.4
 * names the two ways of getting this wrong:
 *
 * - `SET rev = (SELECT MAX(rev) + 1 ...)` gives **every** row the same
 *   number. The subquery is uncorrelated, so SQLite evaluates it once. Three
 *   rows sharing rev 4 means a client that reads two of them and stores
 *   `next_rev = 4` never sees the third, for ever, with nothing on screen to
 *   say so. `UNIQUE(baby_id, rev)` turns that into a failed write rather
 *   than silent loss, which is the whole reason the index exists.
 * - One `UPDATE` per event blows the fifty-query budget (spec 4.2) as soon
 *   as a tag is on fifty records, which is an ordinary number for a tag.
 *
 * So: a window function numbers the affected rows and each takes the
 * maximum plus its own offset.
 *
 * **It reads `event_tags` to find them, so it has to run before those rows
 * are deleted** (spec 7.9). Ordered after the delete it matches nothing, the
 * revs never move, and the other phone shows a tag that no longer exists
 * until somebody reinstalls the app.
 *
 * **Every clause is scoped to the baby on the path**, and the id is bound
 * four times to say so. Not belt and braces: a tag id from one family
 * reaching a handler for another must touch nothing at all, and the rev
 * allocation is the worst place to be loose -- its base is that baby's
 * `MAX(rev)`, so applying it to another baby's events would hand them revs
 * from an unrelated sequence and break the cursor for both.
 *
 * Parameters, in order: baby id (the base), baby id (the target rows), tag
 * id, `updated_at`, tag id and baby id (the tag's own ownership).
 */
export const BUMP_REV_FOR_TAG = `
WITH base AS (SELECT COALESCE(MAX(rev), 0) AS m FROM events WHERE baby_id = ?),
     tgt  AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                FROM events
               WHERE baby_id = ?
                 AND id IN (SELECT event_id FROM event_tags WHERE tag_id = ?))
UPDATE events
   SET rev = (SELECT m FROM base) + (SELECT n FROM tgt WHERE tgt.id = events.id),
       updated_at = ?
 WHERE id IN (SELECT id FROM tgt)
   AND EXISTS (SELECT 1 FROM tags WHERE id = ? AND baby_id = ?)`;

export type EventRow = typeof events.$inferSelect;

/** The wire shape lives in shared, beside the request schemas. */
export type EventResponse = EventDto;

/** Stored metadata is trusted to be an object; anything else is a bug. */
export function parseMetadata(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function toEventResponse(row: EventRow, tagIds: string[] = []): EventResponse {
  return {
    id: row.id,
    babyId: row.babyId,
    typeId: row.typeId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    localDate: row.localDate,
    value: row.value,
    note: row.note,
    metadata: parseMetadata(row.metadata),
    version: row.version,
    rev: row.rev,
    active: row.active === 1,
    deletedAt: row.deletedAt,
    tagIds,
  };
}

type Db = Env['Variables']['db'];

export async function findEvent(db: Db, eventId: string): Promise<EventRow | undefined> {
  const rows = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  return rows[0];
}

export async function tagIdsFor(db: Db, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ tagId: eventTags.tagId })
    .from(eventTags)
    .where(eq(eventTags.eventId, eventId))
    .orderBy(asc(eventTags.tagId));
  return rows.map((row) => row.tagId);
}

export async function loadEvent(db: Db, eventId: string): Promise<EventResponse | null> {
  const row = await findEvent(db, eventId);
  if (!row) return null;
  return toEventResponse(row, await tagIdsFor(db, eventId));
}

/**
 * Every tag belonging to a baby.
 *
 * Read whole rather than checking the submitted ids with an `IN` list: a
 * bound list is capped at a hundred parameters and grows with the request,
 * while a family's tag list is small and bounded by the family (spec 4.2).
 */
export async function babyTagIds(db: Db, babyId: string): Promise<Set<string>> {
  const rows = await db.select({ id: tags.id }).from(tags).where(eq(tags.babyId, babyId));
  return new Set(rows.map((row) => row.id));
}

export type EventPage = EventPageDto;

/**
 * One page of the incremental sync feed (spec 5.4).
 *
 * Tombstones are included: a client that never hears about a deletion keeps
 * showing the row forever.
 */
export async function eventsSince(
  db: Db,
  babyId: string,
  since: number,
  limit: number,
): Promise<EventPage> {
  // One row beyond the page, so `has_more` is a fact rather than a guess
  // that costs the client an extra empty round trip.
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.babyId, babyId), gt(events.rev, since)))
    .orderBy(asc(events.rev))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // An empty page returns the cursor the client sent, never zero and never
  // null: either would make it resynchronise from the beginning (spec 5.4).
  const nextRev = last ? last.rev : since;

  const window = and(
    eq(events.babyId, babyId),
    gt(events.rev, since),
    sql`${events.rev} <= ${nextRev}`,
  );

  return { events: await withTags(db, page, window), nextRev, hasMore };
}

/**
 * Attaches tags to a page of events with one query.
 *
 * Joined on the same condition that selected the page rather than on a list
 * of event ids: a page holds up to a thousand rows and a query may bind a
 * hundred parameters (spec 2.5, 4.2).
 */
async function withTags(db: Db, rows: EventRow[], scope: SQL | undefined): Promise<EventResponse[]> {
  if (rows.length === 0) return [];

  const pairs = await db
    .select({ eventId: eventTags.eventId, tagId: eventTags.tagId })
    .from(eventTags)
    .innerJoin(events, eq(events.id, eventTags.eventId))
    .where(scope)
    .orderBy(asc(eventTags.tagId));

  const byEvent = new Map<string, string[]>();
  for (const pair of pairs) {
    const list = byEvent.get(pair.eventId);
    if (list) list.push(pair.tagId);
    else byEvent.set(pair.eventId, [pair.tagId]);
  }

  return rows.map((row) => toEventResponse(row, byEvent.get(row.id) ?? []));
}

/**
 * Today's list for the home screen.
 *
 * Newest first, with the id as a tiebreak so two events recorded in the same
 * second do not swap places between reloads (spec 5.5). All-day events are
 * lifted to the top by the web layer, which is where that is a presentation
 * decision rather than a query.
 */
export async function eventsOnDate(
  db: Db,
  babyId: string,
  localDate: string,
): Promise<EventResponse[]> {
  const scope = and(
    eq(events.babyId, babyId),
    eq(events.localDate, localDate),
    isNull(events.deletedAt),
  );

  const rows = await db
    .select()
    .from(events)
    .where(scope)
    .orderBy(desc(events.startedAt), desc(events.id));

  return withTags(db, rows, scope);
}
