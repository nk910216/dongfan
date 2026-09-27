import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createTagRequest, updateTagRequest } from '@dongfan/shared';
import { tags } from '../db/schema.js';
import { BUMP_REV_FOR_TAG } from '../lib/events.js';
import { fail, failValidation, zodToFieldErrors } from '../lib/errors.js';
import { requireBabyAccess } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

/**
 * Tags belong to the baby, not to the person who created them: both parents
 * see the same list, and a tag made for one baby never shows up under
 * another (spec 3.7).
 *
 * Renaming and deleting both have to move every event the tag is on, one
 * rev per row and in one statement, because incremental sync watches
 * `events.rev` and nothing else (spec 5.4, 7.9). The reasoning is with
 * those two handlers at the foot of this file.
 */
export const tagRoutes = new Hono<Env>();

tagRoutes.get('/:babyId/tags', requireBabyAccess(), async (c) => {
  const rows = await c
    .get('db')
    .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt })
    .from(tags)
    .where(eq(tags.babyId, c.get('babyId')))
    .orderBy(asc(tags.name));

  return c.json({ tags: rows });
});

tagRoutes.post('/:babyId/tags', requireBabyAccess(), async (c) => {
  const parsed = createTagRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const babyId = c.get('babyId');

  // A repeated name returns the tag that already exists rather than failing.
  // Two parents adding the same tag on the same evening is ordinary, and a
  // unique index error would be a puzzle rather than an answer.
  const existing = await db
    .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt })
    .from(tags)
    .where(eq(tags.babyId, babyId))
    .orderBy(asc(tags.name));

  const already = existing.find((tag) => tag.name === parsed.data.name);
  if (already) return c.json(already, 200);

  const row = {
    id: crypto.randomUUID(),
    babyId,
    name: parsed.data.name,
    createdBy: c.get('user').id,
    createdAt: Date.now(),
  };
  await db.insert(tags).values(row);

  return c.json({ id: row.id, name: row.name, createdAt: row.createdAt }, 201);
});

/**
 * Renaming a tag, and deleting one.
 *
 * Both move every event the tag is on, because incremental sync watches
 * `events.rev` and nothing else (spec 5.4). A rename that touched only the
 * `tags` row, or a delete that removed only the `event_tags` rows, would
 * leave the other phone showing the old name -- or a tag that no longer
 * exists -- for ever, with no symptom anywhere (spec 7.9).
 *
 * Three things have to be true of the statements below, and the order is
 * the whole of it:
 *
 * 1. The revs are bumped **first**, while `event_tags` still has the rows
 *    the numbering SQL finds the affected events through.
 * 2. Then the associations go.
 * 3. Then the tag itself.
 *
 * All in one `batch()`, so a failure anywhere leaves none of it done
 * (spec 4.3).
 */

/** Scoped to the baby on the path: a tag id from another family is a 404. */
const RENAME_TAG = 'UPDATE tags SET name = ? WHERE id = ? AND baby_id = ?';

const DETACH_ALL = 'DELETE FROM event_tags WHERE tag_id = ?';

const DELETE_TAG = 'DELETE FROM tags WHERE id = ? AND baby_id = ?';

tagRoutes.patch('/:babyId/tags/:tagId', requireBabyAccess(), async (c) => {
  const parsed = updateTagRequest.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return failValidation(c, zodToFieldErrors(parsed.error.issues));

  const db = c.get('db');
  const babyId = c.get('babyId');
  const tagId = c.req.param('tagId');

  const rows = await db
    .select({ id: tags.id, name: tags.name, createdAt: tags.createdAt })
    .from(tags)
    .where(eq(tags.babyId, babyId))
    .orderBy(asc(tags.name));

  const tag = rows.find((one) => one.id === tagId);
  if (!tag) return fail(c, 'NOT_FOUND');

  // Nothing to do, and nothing to tell the other phone about. Bumping every
  // event's rev for a rename to the name it already has would be a sync for
  // no change, on a list that can be long.
  if (tag.name === parsed.data.name) return c.json(tag);

  // `UNIQUE(baby_id, name)` would refuse this anyway; answering with a code
  // beats answering with a constraint error. Merging the two tags instead
  // would be a destructive guess at what was meant.
  if (rows.some((one) => one.id !== tagId && one.name === parsed.data.name)) {
    return fail(c, 'TAG_NAME_TAKEN');
  }

  const now = Date.now();
  let results;
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(BUMP_REV_FOR_TAG).bind(babyId, tagId, now, tagId),
      c.env.DB.prepare(RENAME_TAG).bind(parsed.data.name, tagId, babyId),
    ]);
  } catch (error) {
    // The check above is not a lock. Two parents renaming two tags to the
    // same word at the same moment both pass it, and one of them then meets
    // `UNIQUE(baby_id, name)`.
    //
    // Which constraint failed is decided **from the database**, not from
    // the driver's error text: message formats are not a contract, and
    // reading one wrong would turn every database fault into "that name is
    // taken". Nothing was written either way -- the batch rolled back, so
    // the events this rename would have moved are untouched.
    if (await nameTaken(c.get('db'), babyId, tagId, parsed.data.name)) {
      return fail(c, 'TAG_NAME_TAKEN');
    }
    throw error;
  }

  // What the write actually did, not what the read before it saw. The tag
  // can be deleted by the other phone in between, and the rename then
  // matches nothing -- answering 200 with the row read earlier would report
  // a change that did not happen, to a tag that no longer exists
  // (spec 4.3).
  //
  // **On this path the guard is not observable from a test.** Reaching it
  // needs a delete to land between the read above and the write below, and
  // the test runtime settles one request entirely before the other reads,
  // so the read is always the one that answers. It is reachable in
  // production, where the two are separate invocations. The same helper is
  // covered on the delete path, which has no read in front of it.
  if (changedRows(results) === 0) return fail(c, 'NOT_FOUND');

  return c.json({ id: tag.id, name: parsed.data.name, createdAt: tag.createdAt });
});

tagRoutes.delete('/:babyId/tags/:tagId', requireBabyAccess(), async (c) => {
  const babyId = c.get('babyId');
  const tagId = c.req.param('tagId');

  // No read first. Whether the tag exists is decided by what the write
  // touched, which is the same answer one query cheaper -- and a read
  // before the write could only ever be stale by the time the write ran.
  const now = Date.now();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(BUMP_REV_FOR_TAG).bind(babyId, tagId, now, tagId),
    c.env.DB.prepare(DETACH_ALL).bind(tagId),
    c.env.DB.prepare(DELETE_TAG).bind(tagId, babyId),
  ]);

  // Nothing deleted means there was nothing of this baby's to delete: an
  // id that was never real, one belonging to another family, or one the
  // other phone removed a moment ago. 404 for all three -- confirming that
  // an id exists is itself something a stranger should not learn
  // (spec 6.4).
  if (changedRows(results) === 0) return fail(c, 'NOT_FOUND');

  return c.body(null, 204);
});

/**
 * What the last statement in a batch changed.
 *
 * `meta.changes` decides the response and nothing else: checking it is too
 * late to roll anything back, and the guard that decides whether the write
 * happens is the predicate on the statement itself (spec 4.3).
 */
function changedRows(results: readonly D1Result[]): number {
  return results[results.length - 1]?.meta.changes ?? 0;
}

/** Whether some *other* tag of this baby already carries the name. */
async function nameTaken(
  db: Env['Variables']['db'],
  babyId: string,
  tagId: string,
  name: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.babyId, babyId));
  return rows.some((one) => one.id !== tagId && one.name === name);
}
