import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createTagRequest } from '@dongfan/shared';
import { tags } from '../db/schema.js';
import { failValidation, zodToFieldErrors } from '../lib/errors.js';
import { requireBabyAccess } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

/**
 * Tags belong to the baby, not to the person who created them: both parents
 * see the same list, and a tag made for one baby never shows up under
 * another (spec 3.7).
 *
 * Renaming and deleting are not here. Both have to bump the rev of every
 * event carrying the tag, one rev per row, which is a batch problem of its
 * own (spec 5.4, 7.9). Adding a half version now would mean writing the
 * broken one first.
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
