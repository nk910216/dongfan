import { Hono } from 'hono';
import {
  MAX_EVENTS_PER_DAY,
  createEventRequest, deleteEventRequest, syncQuery, updateEventRequest,
  getEventType, isRealLocalDate, resolveEventTimes, toLocalDate, validateEvent,
} from '@dongfan/shared';
import type { EventIntent, FieldError } from '@dongfan/shared';
import {
  NEXT_REV, babyTagIds, eventsOnDate, eventsSince, findEvent, loadEvent, parseMetadata,
  tagIdsFor, toEventResponse,
} from '../lib/events.js';
import type { EventRow } from '../lib/events.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import { buildSummary } from '../lib/summary.js';
import { requireBabyAccess, requireEventAccess } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

/**
 * Event routes.
 *
 * Writes go through raw batched statements rather than the query builder.
 * That is not a style preference: the version guard has to be a predicate on
 * every statement in the transaction, because `batch()` only rolls back when
 * a statement *fails*, and a conditional UPDATE matching no rows is not a
 * failure. Checking afterwards would report a conflict while the tag rows
 * had already been rewritten (spec 4.3).
 */

export const babyEventRoutes = new Hono<Env>();
export const eventRoutes = new Hono<Env>();

const INSERT_EVENT = `
INSERT INTO events (
  id, baby_id, type_id, created_by, created_at, updated_at,
  started_at, ended_at, local_date, value, note, metadata,
  version, rev, active, deleted_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ${NEXT_REV}, ?, NULL)
ON CONFLICT(id) DO NOTHING`;

/**
 * Attaching a tag, with the ownership checks inside the statement.
 *
 * Both the event and the tag have to belong to the same baby, or a valid tag
 * id from one family could be hung on another family's event (spec 4.3).
 * Expressed as a join so the guard cannot be forgotten at a call site.
 */
const ATTACH_TAG = `
INSERT INTO event_tags (event_id, tag_id)
SELECT e.id, t.id
  FROM events e
  JOIN tags t ON t.baby_id = e.baby_id
 WHERE e.id = ? AND t.id = ? AND e.baby_id = ?
ON CONFLICT DO NOTHING`;

/** The same statement with the optimistic lock added to its row lookup. */
const ATTACH_TAG_GUARDED = `
INSERT INTO event_tags (event_id, tag_id)
SELECT e.id, t.id
  FROM events e
  JOIN tags t ON t.baby_id = e.baby_id
 WHERE e.id = ? AND t.id = ? AND e.baby_id = ? AND e.version = ?
ON CONFLICT DO NOTHING`;

const DETACH_TAGS_GUARDED = `
DELETE FROM event_tags
 WHERE event_id = ?
   AND EXISTS (SELECT 1 FROM events WHERE id = ? AND version = ?)`;

/**
 * The event body, last in the batch.
 *
 * Incrementing the version has to come last, or the guards on the statements
 * before it would be comparing against a version this transaction has
 * already moved (spec 4.3).
 */
const UPDATE_EVENT = `
UPDATE events
   SET started_at = ?, ended_at = ?, local_date = ?, value = ?, note = ?, metadata = ?,
       active = ?, updated_at = ?,
       version = version + 1,
       rev = ${NEXT_REV}
 WHERE id = ? AND version = ?`;

/**
 * A deletion is a tombstone, never a removed row.
 *
 * All four of deleted_at, rev, version and updated_at move together: without
 * the new rev the tombstone never appears in an incremental sync, and the
 * other phone goes on showing the event forever (spec 6.3).
 */
const SOFT_DELETE_EVENT = `
UPDATE events
   SET deleted_at = ?, updated_at = ?, active = NULL,
       version = version + 1,
       rev = ${NEXT_REV}
 WHERE id = ? AND version = ? AND deleted_at IS NULL`;

function unknownType(typeId: string): FieldError[] {
  return [{ field: 'typeId', code: 'INVALID_ENUM', params: { typeId } }];
}

async function unknownTags(
  db: Env['Variables']['db'],
  babyId: string,
  tagIds: readonly string[],
): Promise<FieldError[]> {
  if (tagIds.length === 0) return [];
  const owned = await babyTagIds(db, babyId);
  return tagIds
    .filter((id) => !owned.has(id))
    .map((id, index): FieldError => ({ field: `tagIds.${index}`, code: 'INVALID_ENUM', params: { id } }));
}

// ---------------------------------------------------------------- creating

babyEventRoutes.post('/:babyId/events', requireBabyAccess(), async (c) => {
  const parsed = createEventRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const input = parsed.data;
  const db = c.get('db');
  const baby = c.get('baby');

  // Idempotency first, before any other check.
  //
  // A POST that succeeded but lost its response comes back unchanged, and
  // the queue has to be told "this one is already in" rather than being
  // failed by a limit or a rule (spec 5.8). Read back scoped to the baby:
  // matching on the id alone would let a POST read out an event belonging
  // to someone else's baby, bypassing the check on the path.
  const existing = await findEvent(db, input.id);
  if (existing) {
    if (existing.babyId !== baby.id) return fail(c, 'ID_CONFLICT');
    return c.json(toEventResponse(existing, await tagIdsFor(db, input.id)), 200);
  }

  const type = getEventType(input.typeId);
  if (!type) return failValidation(c, unknownType(input.typeId));

  const now = Date.now();
  const errors = validateEvent(type, input, { now, timeZone: baby.timezone, birthDate: baby.birthDate });
  errors.push(...(await unknownTags(db, baby.id, input.tagIds ?? [])));
  if (errors.length > 0) return failValidation(c, errors);

  const times = resolveEventTimes(type, input, baby.timezone);
  const localDate = toLocalDate(times.startedAt, baby.timezone);

  // Counted after the idempotency check and including tombstones: counting
  // live rows only would let create-delete-create loop past the breaker,
  // and checking the limit first would fail the resend of an event that is
  // already stored (spec 5.7, 5.8).
  const used = await countOnDate(c.env.DB, baby.id, localDate);
  if (used >= MAX_EVENTS_PER_DAY) {
    return fail(c, 'DAILY_LIMIT_EXCEEDED', { limit: MAX_EVENTS_PER_DAY });
  }

  const statements = [
    c.env.DB.prepare(INSERT_EVENT).bind(
      input.id, baby.id, type.id, c.get('user').id, now, now,
      times.startedAt, times.endedAt, localDate,
      input.value ?? 1, input.note ?? '', JSON.stringify(input.metadata ?? {}),
      baby.id, times.active ? 1 : null,
    ),
    ...(input.tagIds ?? []).map((tagId) =>
      c.env.DB.prepare(ATTACH_TAG).bind(input.id, tagId, baby.id)),
  ];

  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    // Which constraint failed is decided from the database, not from the
    // driver's error text: message formats are not a contract, and reading
    // one wrong turns two phones racing to start the same timer into a 500
    // instead of the answer the second one needs (spec 3.5).
    const after = await loadEvent(db, input.id);
    if (after) return c.json(after, 200);
    if (times.active && (await hasRunningTimer(c.env.DB, baby.id, type.id))) {
      return fail(c, 'ACTIVE_TIMER_EXISTS');
    }
    throw error;
  }

  const created = await loadEvent(db, input.id);
  // The insert was a no-op and nothing is there: the only way that happens
  // is a concurrent request holding the active slot.
  if (!created) return fail(c, 'ACTIVE_TIMER_EXISTS');
  return c.json(created, 201);
});

async function countOnDate(DB: D1Database, babyId: string, localDate: string): Promise<number> {
  const row = await DB
    .prepare('SELECT COUNT(*) AS n FROM events WHERE baby_id = ? AND local_date = ?')
    .bind(babyId, localDate)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function hasRunningTimer(DB: D1Database, babyId: string, typeId: string): Promise<boolean> {
  const row = await DB
    .prepare('SELECT id FROM events WHERE baby_id = ? AND type_id = ? AND active = 1 LIMIT 1')
    .bind(babyId, typeId)
    .first<{ id: string }>();
  return row !== null;
}

// ---------------------------------------------------------------- reading

/** Incremental sync. The cursor is a rev, never a timestamp (spec 5.4). */
babyEventRoutes.get('/:babyId/events', requireBabyAccess(), async (c) => {
  const parsed = syncQuery.safeParse(c.req.query());
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const page = await eventsSince(c.get('db'), c.get('babyId'), parsed.data.since, parsed.data.limit);
  return c.json({ events: page.events, nextRev: page.nextRev, hasMore: page.hasMore });
});

/** One calendar day in the baby's timezone, for the home and calendar screens. */
babyEventRoutes.get('/:babyId/events/day/:date', requireBabyAccess(), async (c) => {
  const date = c.req.param('date');
  if (!isRealLocalDate(date)) {
    return failValidation(c, [{ field: 'date', code: 'INVALID_FORMAT', params: {} }]);
  }
  return c.json({ date, events: await eventsOnDate(c.get('db'), c.get('babyId'), date) });
});

babyEventRoutes.get('/:babyId/events/summary', requireBabyAccess(), async (c) => {
  const baby = c.get('baby');
  const today = toLocalDate(Date.now(), baby.timezone);
  // The date the totals cover travels with them. The client could work it
  // out from the timezone, but then two clocks decide what "today" means.
  return c.json({ date: today, ...(await buildSummary(c.env.DB, baby.id, today)) });
});

eventRoutes.get('/:eventId', requireEventAccess(), async (c) => {
  const event = await loadEvent(c.get('db'), c.req.param('eventId'));
  if (!event || event.deletedAt !== null) return fail(c, 'NOT_FOUND');
  return c.json(event);
});

// ---------------------------------------------------------------- updating

/**
 * Decides what the row looks like after a patch.
 *
 * `active` is never taken from the client: it is set when a timer starts and
 * cleared the moment an end time exists, which is what keeps the column and
 * the CHECK constraint agreeing (spec 3.8).
 */
function merge(current: EventRow, patch: {
  startedAt?: number | undefined;
  endedAt?: number | null | undefined;
  value?: number | undefined;
  note?: string | undefined;
  metadata?: Record<string, string> | undefined;
}): {
  intent: EventIntent;
  startedAt: number;
  endedAt: number | null;
  value: number;
  note: string;
  metadata: Record<string, string>;
} {
  const endedAt = patch.endedAt === undefined ? current.endedAt : patch.endedAt;
  const wasRunning = current.active === 1;

  return {
    // Only a still-running timer keeps its slot. Supplying an end time is
    // how a timer is stopped, and it must give the slot back.
    intent: wasRunning && endedAt === null ? 'start_timer' : 'record',
    startedAt: patch.startedAt ?? current.startedAt,
    endedAt,
    value: patch.value ?? current.value,
    note: patch.note ?? current.note,
    metadata: patch.metadata ?? parseMetadata(current.metadata),
  };
}

eventRoutes.patch('/:eventId', requireEventAccess(), async (c) => {
  const parsed = updateEventRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const baby = c.get('baby');
  const eventId = c.req.param('eventId');

  const current = await findEvent(db, eventId);
  if (!current || current.deletedAt !== null) return fail(c, 'NOT_FOUND');

  const type = getEventType(current.typeId);
  if (!type) return failValidation(c, unknownType(current.typeId));

  const next = merge(current, parsed.data);
  const now = Date.now();
  const errors = validateEvent(type, next, { now, timeZone: baby.timezone, birthDate: baby.birthDate });
  errors.push(...(await unknownTags(db, baby.id, parsed.data.tagIds ?? [])));
  if (errors.length > 0) return failValidation(c, errors);

  const times = resolveEventTimes(type, next, baby.timezone);
  const localDate = toLocalDate(times.startedAt, baby.timezone);
  const expected = parsed.data.version;

  const statements = [
    // Tag writes carry the same guard as the body. If the version has moved,
    // every one of them matches nothing and the transaction leaves the event
    // and its tags exactly as they were.
    ...(parsed.data.tagIds === undefined
      ? []
      : [
          c.env.DB.prepare(DETACH_TAGS_GUARDED).bind(eventId, eventId, expected),
          ...parsed.data.tagIds.map((tagId) =>
            c.env.DB.prepare(ATTACH_TAG_GUARDED).bind(eventId, tagId, baby.id, expected)),
        ]),
    c.env.DB.prepare(UPDATE_EVENT).bind(
      times.startedAt, times.endedAt, localDate,
      next.value, next.note, JSON.stringify(next.metadata),
      times.active ? 1 : null, now,
      baby.id, eventId, expected,
    ),
  ];

  let results;
  try {
    results = await c.env.DB.batch(statements);
  } catch (error) {
    if (times.active && (await hasRunningTimer(c.env.DB, baby.id, type.id))) {
      return fail(c, 'ACTIVE_TIMER_EXISTS');
    }
    throw error;
  }

  // Only now, and only to choose the response: by this point nothing was
  // written if the version did not match (spec 4.3).
  const applied = results[results.length - 1]?.meta.changes ?? 0;
  if (applied === 0) return fail(c, 'VERSION_CONFLICT');

  return c.json(await loadEvent(db, eventId));
});

eventRoutes.delete('/:eventId', requireEventAccess(), async (c) => {
  const parsed = deleteEventRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const eventId = c.req.param('eventId');

  const current = await findEvent(db, eventId);
  if (!current || current.deletedAt !== null) return fail(c, 'NOT_FOUND');

  const now = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(SOFT_DELETE_EVENT).bind(
      now, now, c.get('babyId'), eventId, parsed.data.version,
    ),
  ]);

  if ((results[0]?.meta.changes ?? 0) === 0) return fail(c, 'VERSION_CONFLICT');

  // The tombstone is returned rather than an empty body, so the client can
  // store it with its new rev instead of dropping the row (spec 6.2).
  return c.json(await loadEvent(db, eventId));
});
