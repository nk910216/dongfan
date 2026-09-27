import { and, asc, eq } from 'drizzle-orm';
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
  await c.env.DB.batch([
    c.env.DB.prepare(BUMP_REV_FOR_TAG).bind(babyId, tagId, now, tagId),
    c.env.DB.prepare(RENAME_TAG).bind(parsed.data.name, tagId, babyId),
  ]);

  return c.json({ id: tag.id, name: parsed.data.name, createdAt: tag.createdAt });
});

tagRoutes.delete('/:babyId/tags/:tagId', requireBabyAccess(), async (c) => {
  const babyId = c.get('babyId');
  const tagId = c.req.param('tagId');

  const rows = await c
    .get('db')
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.babyId, babyId)))
    .limit(1);

  if (rows.length === 0) return fail(c, 'NOT_FOUND');

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(BUMP_REV_FOR_TAG).bind(babyId, tagId, now, tagId),
    c.env.DB.prepare(DETACH_ALL).bind(tagId),
    c.env.DB.prepare(DELETE_TAG).bind(tagId, babyId),
  ]);

  return c.body(null, 204);
});
