/**
 * Splitting a D1 export into statements, so a restore can be applied in two
 * passes.
 *
 * `wrangler d1 execute --file` will not ingest wrangler's own export as it
 * stands. The dump orders tables alphabetically, so `baby_members` and its
 * foreign key to `users` arrive before `users` exists; the
 * `PRAGMA defer_foreign_keys=TRUE` at the top does not survive, because the
 * statements are not run inside one transaction. The restore stops with
 * "no such table: main.users" partway through, leaving some tables filled
 * and some empty.
 *
 * Applying every CREATE first and every INSERT second removes the ordering
 * problem entirely: by the time a row is written, every table it refers to
 * is there.
 *
 * Splitting is done here rather than with a line-based filter because a
 * note a parent typed may contain a semicolon or a newline, and either
 * would cut a statement in half without anything noticing.
 */

/**
 * Splits SQL into statements on semicolons that are not inside a string.
 *
 * SQLite's only escape inside a single-quoted string is a doubled quote, so
 * tracking that one rule is enough for a dump.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i += 1) {
    const character = sql[i];

    if (inString) {
      current += character;
      if (character === "'") {
        // A doubled quote is a literal quote, not the end of the string.
        if (sql[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (character === "'") {
      inString = true;
      current += character;
      continue;
    }

    if (character === ';') {
      const trimmed = current.trim();
      if (trimmed !== '') statements.push(trimmed);
      current = '';
      continue;
    }

    current += character;
  }

  const last = current.trim();
  if (last !== '') statements.push(last);
  return statements;
}

const INSERT = /^INSERT\s+INTO/i;

/**
 * Separates the statements that build the database from the ones that fill
 * it.
 *
 * Indexes stay in the first pass on purpose. Restoring under the unique
 * index on `(baby_id, rev)` means a dump carrying two rows with the same
 * rev fails the drill rather than restoring quietly and losing rows from
 * pagination later (spec 5.4).
 */
export function partitionRestore(statements) {
  const schema = [];
  const data = [];

  for (const statement of statements) {
    if (INSERT.test(statement)) data.push(statement);
    else schema.push(statement);
  }

  return { schema, data };
}

/** How many rows a dump carries for one table. */
export function countRowsFor(statements, table) {
  const pattern = new RegExp(`^INSERT\\s+INTO\\s+[\`"']?${table}[\`"']?\\s`, 'i');
  return statements.filter((statement) => pattern.test(statement)).length;
}
