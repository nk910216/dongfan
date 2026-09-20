import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Database schema.
 *
 * Columns the first milestone does not use yet are present from the start:
 * `version`, `rev` and `deleted_at` are cheap to add now and expensive to
 * backfill later, and every one of them guards a failure that is silent
 * (spec 12).
 */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** `pbkdf2$sha256$<iterations>$<salt>$<hash>`; the cost is in the string. */
    passwordHash: text('password_hash').notNull(),
    /** Set instead of deleting, so events keep a valid created_by. */
    disabledAt: integer('disabled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // Case-insensitive on purpose: SQLite compares case-sensitively by
    // default, which would make "whether login is case-sensitive" an
    // accident of implementation.
    uniqueIndex('idx_users_username').on(sql`lower(${t.username})`),
  ],
);

export const babies = sqliteTable('babies', {
  id: text('id').primaryKey(),
  nickname: text('nickname').notNull(),
  gender: text('gender').notNull(),
  /** A calendar day in the baby's timezone, never a timestamp (spec 4). */
  birthDate: text('birth_date').notNull(),
  timezone: text('timezone').notNull().default('Asia/Taipei'),
  createdAt: integer('created_at').notNull(),
});

export const babyMembers = sqliteTable(
  'baby_members',
  {
    babyId: text('baby_id').notNull().references(() => babies.id),
    userId: text('user_id').notNull().references(() => users.id),
    /** 'owner' or 'member'; the creator is the first owner (spec 4). */
    role: text('role').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.babyId] }),
    index('idx_members_baby').on(t.babyId),
  ],
);

export const events = sqliteTable(
  'events',
  {
    /** Client-generated UUID, doubling as the idempotency key (spec 3.8). */
    id: text('id').primaryKey(),
    babyId: text('baby_id').notNull().references(() => babies.id),
    typeId: text('type_id').notNull(),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    /** Server-computed from startedAt and the baby's timezone (spec 5.3). */
    localDate: text('local_date').notNull(),
    value: integer('value').notNull().default(1),
    note: text('note').notNull().default(''),
    metadata: text('metadata').notNull().default('{}'),
    version: integer('version').notNull().default(1),
    /** Monotonic per baby; the sync cursor, never a timestamp (spec 5.4). */
    rev: integer('rev').notNull(),
    /** 1 only while a timer runs. Not derivable from endedAt (spec 3.5). */
    active: integer('active'),
    deletedAt: integer('deleted_at'),
  },
  (t) => [
    // Unique so a batch update that reuses one rev fails loudly instead of
    // silently dropping rows from pagination (spec 5.4).
    uniqueIndex('idx_events_baby_rev').on(t.babyId, t.rev),
    index('idx_events_baby_date').on(t.babyId, t.localDate, t.startedAt),
    index('idx_events_stats').on(t.babyId, t.typeId, t.localDate),
    index('idx_events_baby_type').on(t.babyId, t.typeId, sql`${t.startedAt} DESC`),
    // One running timer per type per baby, enforced by the database because
    // two phones pressing start at once beat any application-level check.
    uniqueIndex('idx_events_active').on(t.babyId, t.typeId).where(sql`${t.active} = 1`),
    check('events_active_consistent', sql`${t.active} IS NULL OR (${t.endedAt} IS NULL AND ${t.deletedAt} IS NULL)`),
  ],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    babyId: text('baby_id').notNull().references(() => babies.id),
    name: text('name').notNull(),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_tags_baby_name').on(t.babyId, t.name)],
);

export const eventTags = sqliteTable(
  'event_tags',
  {
    eventId: text('event_id').notNull().references(() => events.id),
    tagId: text('tag_id').notNull().references(() => tags.id),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.tagId] }),
    index('idx_event_tags_tag').on(t.tagId),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    /** Unsalted SHA-256 so the token can be looked up (spec 9.2). */
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_sessions_hash').on(t.tokenHash),
    index('idx_sessions_user').on(t.userId),
  ],
);

export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    id: text('id').primaryKey(),
    babyId: text('baby_id').notNull().references(() => babies.id),
    /** Unsalted SHA-256, for the same lookup reason as sessions (spec 6.5). */
    codeHash: text('code_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    usedBy: text('used_by').references(() => users.id),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('idx_invites_hash').on(t.codeHash)],
);
