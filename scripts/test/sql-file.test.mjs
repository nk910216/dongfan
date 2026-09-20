import { describe, expect, it } from 'vitest';
import { countRowsFor, partitionRestore, splitStatements } from '../lib/sql-file.mjs';

/**
 * A bad split does not throw. It writes half a statement, or joins two, and
 * the restore that comes out looks like a restore. These are the cases that
 * a line-based filter gets wrong (spec 12.2).
 */

describe('splitting statements', () => {
  it('splits on semicolons and drops the blanks', () => {
    expect(splitStatements('SELECT 1; SELECT 2;\n\n')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('leaves a semicolon inside a value alone', () => {
    const sql = `INSERT INTO "events" ("note") VALUES('fed; then slept');\nSELECT 1;`;
    const statements = splitStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('fed; then slept');
  });

  it('leaves a newline inside a value alone', () => {
    // A note is free text and the API accepts one with line breaks in it.
    const sql = `INSERT INTO "events" ("note") VALUES('first line\nsecond line');`;
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('reads a doubled quote as a quote, not as the end of the string', () => {
    const sql = `INSERT INTO "events" ("note") VALUES('it''s fine; really');\nSELECT 1;`;
    const statements = splitStatements(sql);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("it''s fine; really");
  });

  it('keeps a statement that never ended', () => {
    // Better a restore that fails on malformed SQL than one that silently
    // leaves the last rows out.
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('ordering a restore', () => {
  const dump = [
    'PRAGMA defer_foreign_keys=TRUE',
    'CREATE TABLE `baby_members` (`user_id` text REFERENCES `users`(`id`))',
    `INSERT INTO "baby_members" ("user_id") VALUES('u1')`,
    'CREATE TABLE `users` (`id` text PRIMARY KEY)',
    `INSERT INTO "users" ("id") VALUES('u1')`,
    'CREATE UNIQUE INDEX `idx_events_baby_rev` ON `events` (`baby_id`,`rev`)',
  ];

  it('builds everything before filling anything', () => {
    const { schema, data } = partitionRestore(dump);

    // The dump orders tables alphabetically, so baby_members and its
    // foreign key arrive before users exists. Applied as written, the
    // restore stops partway with "no such table: main.users".
    expect(schema).toHaveLength(4);
    expect(data).toHaveLength(2);
    expect(data.every((statement) => statement.startsWith('INSERT'))).toBe(true);
  });

  it('keeps the indexes in the first pass', () => {
    const { schema } = partitionRestore(dump);

    // Restoring under the unique index means a dump with two rows sharing
    // a rev fails the drill instead of coming back quietly broken.
    expect(schema.some((statement) => statement.includes('idx_events_baby_rev'))).toBe(true);
  });

  it('counts the rows a dump carries for one table', () => {
    expect(countRowsFor(dump, 'users')).toBe(1);
    expect(countRowsFor(dump, 'baby_members')).toBe(1);
    expect(countRowsFor(dump, 'events')).toBe(0);
  });
});
