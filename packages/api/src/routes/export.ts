import { Hono } from 'hono';
import { exportBaby } from '../lib/export.js';
import { fail } from '../lib/errors.js';
import { requireBabyAccess } from '../middleware/permissions.js';
import type { Env } from '../lib/types.js';

/**
 * `GET /babies/:id/export` (spec 5.9).
 *
 * JSON only. The CSV is made in the web layer from this same document,
 * because a CSV a person can read needs column names, type names and option
 * labels, and the API never returns text for a person to read (spec 13.1).
 */
export const exportRoutes = new Hono<Env>();

exportRoutes.get('/:babyId/export', requireBabyAccess(), async (c) => {
  const baby = c.get('baby');
  const result = await exportBaby(c.env.DB, baby.id, baby.timezone);

  switch (result.kind) {
    case 'too_large':
      return fail(c, 'EXPORT_TOO_LARGE', { eventCount: result.eventCount });
    case 'not_found':
      return fail(c, 'NOT_FOUND');
    case 'moved':
      // More was written between the count and the read than the spare
      // page holds. Asking again is the whole remedy.
      return fail(c, 'INTERNAL');
    case 'ok':
      return new Response(result.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${result.filename}"`,
          // A family's records. No shared cache, and no copy left behind in
          // this one either.
          'Cache-Control': 'no-store',
        },
      });
  }
});
