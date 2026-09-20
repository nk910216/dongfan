import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Brings the isolated test database up to the current schema before any
 * test runs. Each test file gets its own storage, so nothing leaks between
 * them and nothing touches a real database.
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
