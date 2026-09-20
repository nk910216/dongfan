import { z } from 'zod';
import { MAX_NOTE_LENGTH } from './constants.js';

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

export const loginRequest = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

export const createBabyRequest = z.object({
  // User-typed content: any language, stored exactly as given, measured in
  // characters rather than bytes (spec 13.1.1).
  nickname: z.string().min(1).max(50),
  gender: z.enum(['male', 'female', 'other']),
  birthDate: LOCAL_DATE,
  timezone: z.string().min(1).max(64).optional(),
});

export const updateBabyRequest = createBabyRequest.partial();

export const createEventRequest = z.object({
  id: UUID,
  typeId: z.string().min(1).max(50),
  intent: z.enum(['start_timer', 'record']),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  value: z.number().int().optional(),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const updateEventRequest = z.object({
  version: z.number().int().positive(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().nullable().optional(),
  value: z.number().int().optional(),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

export const deleteEventRequest = z.object({ version: z.number().int().positive() });

export type LoginRequest = z.infer<typeof loginRequest>;
export type CreateBabyRequest = z.infer<typeof createBabyRequest>;
export type UpdateBabyRequest = z.infer<typeof updateBabyRequest>;
export type CreateEventRequest = z.infer<typeof createEventRequest>;
export type UpdateEventRequest = z.infer<typeof updateEventRequest>;
