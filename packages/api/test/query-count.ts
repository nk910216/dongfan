import { env } from 'cloudflare:test';
import app from '../src/index.js';

/**
 * Counting the D1 statements one request executes (spec 11.2).
 *
 * The free plan allows 50 per invocation and the local runtime enforces
 * none of them, so a handler that has quietly become N+1 passes every test
 * here and fails in production against a baby with a year of records. The
 * only way to make that limit real is to count in the tests and fail well
 * short of it.
 *
 * The threshold is 30, from spec 11.2: low enough to leave room for the
 * session lookup and the permission check on top of whatever the handler
 * does, and far enough below 50 that a request has to be badly wrong to
 * trip it rather than merely unlucky.
 *
 * `batch()` counts as one per statement, because that is what D1 charges
 * for it -- one round trip, but not one query.
 */
export const MAX_QUERIES_PER_REQUEST = 30;

type Counter = { count: number };

/**
 * Wraps a D1 binding so every executed statement is counted.
 *
 * Wrapped at the binding rather than inside Drizzle: the handlers reach the
 * database both ways -- reads through the query builder, writes as raw
 * statements through `batch()` (spec 4.3) -- and a counter that saw only one
 * of those would report a comfortable number for a request doing twice the
 * work.
 *
 * Counted when a statement is *run*, not when it is prepared. A prepared
 * statement that is never executed costs nothing, and one bound and run
 * twice costs twice.
 */
function counting(real: D1Database, counter: Counter): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;

        if (property === 'bind') {
          return (...args: unknown[]) => wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        if (property === 'all' || property === 'run' || property === 'first' || property === 'raw') {
          return (...args: unknown[]) => {
            counter.count += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });

  return new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      if (property === 'prepare') {
        return (sql: string) => wrapStatement(real.prepare(sql));
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          counter.count += statements.length;
          return real.batch(statements);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          counter.count += 1;
          return real.exec(sql);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

/**
 * Runs one request against a counted binding.
 *
 * The statements a `batch()` carries are counted, but the batch itself is
 * still executed against the real database, so this drives the same request
 * the other tests exercise rather than a stubbed one.
 */
export async function fetchCounting(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<{ response: Response; queries: number }> {
  const counter: Counter = { count: 0 };
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await app.fetch(
    new Request(`http://test${path}`, { ...init, headers }),
    { ...env, DB: counting(env.DB, counter) },
  );

  return { response, queries: counter.count };
}

/**
 * Fails the test if a request cost more than the budget.
 *
 * Separate from the counting so it can be tested with a ceiling low enough
 * to trip: a guard nobody has ever seen refuse anything is not a guard
 * (AGENTS.md).
 */
export function enforceBudget(path: string, queries: number, budget: number): void {
  if (queries > budget) {
    throw new Error(
      `${path} executed ${queries} D1 statements, over the budget of ${budget}. `
      + 'The free plan allows 50 per invocation and the local runtime enforces none of '
      + 'them, so this is the only place an N+1 shows up before production (spec 11.2).',
    );
  }
}

/** Both together, which is what the shared request helper uses. */
export async function requestCounting(
  path: string,
  init: RequestInit = {},
  token?: string,
  budget: number = MAX_QUERIES_PER_REQUEST,
): Promise<{ response: Response; queries: number }> {
  const result = await fetchCounting(path, init, token);
  enforceBudget(path, result.queries, budget);
  return result;
}
