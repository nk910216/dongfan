import { z } from 'zod';
import { MAX_NOTE_LENGTH, MAX_PASSWORD_LENGTH } from './constants.js';
import { passwordLength } from './crypto.js';

/**
 * Request contracts shared by both sides.
 *
 * The API derives its validation from these and the web layer derives its
 * types, so a field cannot drift between them. Note what is absent:
 * `local_date` has no place in any request, because the server computes it
 * from the timestamp and the baby's timezone. Leaving it out of the schema
 * makes sending it impossible rather than merely discouraged (spec 5.3).
 */

const UUID = z.string().uuid();
const LOCAL_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * A length limit counted in characters rather than UTF-16 units.
 *
 * `.max()` counts units, so a note of six hundred emoji would be refused
 * here while every other layer considers it six hundred characters. A rule
 * that two layers count differently is a rule that eventually disagrees
 * with itself (spec 13.1.1).
 */
function boundedText(max: number, min = 0): z.ZodEffects<z.ZodString, string, string> {
  return z.string().min(min).superRefine((value, ctx) => {
    if ([...value].length > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        maximum: max,
        inclusive: true,
        message: 'too long',
      });
    }
  });
}

export const loginRequest = z.object({
  username: z.string().min(1).max(100),
  /**
   * Counted the same way the CLI counts it, so a password that could be set
   * can always be used. `.max()` would count UTF-16 units and refuse a
   * password of two hundred emoji that the CLI happily accepted.
   *
   * Only the upper bound is checked here. The minimum is a policy applied
   * when an account is created; enforcing it at login would lock out every
   * existing account the day the policy is raised, and silently.
   */
  password: z.string().min(1).superRefine((value, ctx) => {
    if (passwordLength(value) > MAX_PASSWORD_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        maximum: MAX_PASSWORD_LENGTH,
        inclusive: true,
        message: 'password too long',
      });
    }
  }),
});

export const createBabyRequest = z.object({
  // User-typed content: any language, stored exactly as given, measured in
  // characters rather than bytes (spec 13.1.1).
  nickname: z.string().min(1).max(50),
  gender: z.enum(['male', 'female', 'other']),
  birthDate: LOCAL_DATE,
  timezone: z.string().min(1).max(64).optional(),
});

/**
 * Timezone is absent on purpose.
 *
 * Changing it would invalidate the stored local_date of every existing
 * event, which is a migration rather than an edit. Leaving the field out of
 * the schema makes that impossible instead of merely discouraged (spec 3.4).
 */
export const updateBabyRequest = createBabyRequest.omit({ timezone: true }).partial();

/**
 * Tag ids are capped well below the hundred bound parameters a D1 query
 * allows (spec 2.5), so attaching them can stay one statement per tag inside
 * a single batch.
 */
const TAG_IDS = z.array(UUID).max(20);

export const createEventRequest = z.object({
  id: UUID,
  typeId: z.string().min(1).max(50),
  intent: z.enum(['start_timer', 'record']),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  value: z.number().int().optional(),
  note: boundedText(MAX_NOTE_LENGTH).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  tagIds: TAG_IDS.optional(),
});

export const updateEventRequest = z.object({
  version: z.number().int().positive(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().nullable().optional(),
  value: z.number().int().optional(),
  note: boundedText(MAX_NOTE_LENGTH).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  tagIds: TAG_IDS.optional(),
});

export const deleteEventRequest = z.object({ version: z.number().int().positive() });

// User-typed content, so any language and counted in characters (spec 13.1.1).
export const createTagRequest = z.object({ name: boundedText(30, 1) });

/**
 * The incremental sync cursor (spec 5.4).
 *
 * `since` is a rev the server issued, never a timestamp, and it arrives as a
 * query string, hence the coercion.
 */
export const syncQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export type LoginRequest = z.infer<typeof loginRequest>;
export type CreateBabyRequest = z.infer<typeof createBabyRequest>;
export type UpdateBabyRequest = z.infer<typeof updateBabyRequest>;
export type CreateEventRequest = z.infer<typeof createEventRequest>;
export type UpdateEventRequest = z.infer<typeof updateEventRequest>;
export type DeleteEventRequest = z.infer<typeof deleteEventRequest>;
export type CreateTagRequest = z.infer<typeof createTagRequest>;
export type SyncQuery = z.infer<typeof syncQuery>;
