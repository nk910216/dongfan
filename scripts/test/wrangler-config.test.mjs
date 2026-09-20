import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../lib/jsonc.mjs';
import { DEV_DATABASE, PRODUCTION_DATABASE } from '../lib/d1.mjs';

/**
 * The worker configuration and the maintenance scripts have to agree about
 * which database is which.
 *
 * They drifted once already: the config bound `DB` to `dongfan-dev` while
 * the backup script and the account CLI both meant `dongfan`. Deploying
 * would have bound the live worker to a database that does not exist
 * remotely, and nothing in the test suite had an opinion about it
 * (spec 13.3).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = parseJsonc(readFileSync(resolve(ROOT, 'packages/api/wrangler.jsonc'), 'utf8'));

const production = config.env?.production;

function d1Of(scope) {
  return scope.d1_databases?.find((binding) => binding.binding === 'DB');
}

describe('the default environment', () => {
  it('is the local development database, so no flag can be forgotten into production', () => {
    expect(d1Of(config)?.database_name).toBe(DEV_DATABASE);
  });

  it('keeps the migrations directory, which the local apply needs', () => {
    expect(d1Of(config)?.migrations_dir).toBe('migrations');
  });
});

describe('the production environment', () => {
  it('exists, because deploy, migrate, backup and the account CLI all name it', () => {
    expect(production).toBeDefined();
  });

  it('binds DB to the database the scripts mean', () => {
    expect(d1Of(production)?.database_name).toBe(PRODUCTION_DATABASE);
  });

  it('is not the development database under another name', () => {
    expect(d1Of(production)?.database_name).not.toBe(DEV_DATABASE);
  });

  it('can run migrations', () => {
    expect(d1Of(production)?.migrations_dir).toBe('migrations');
  });

  it('carries the asset rules, which an environment does not inherit', () => {
    // wrangler replaces rather than merges most top-level keys per
    // environment. Losing run_worker_first here would let the static assets
    // answer an API request with the app's HTML (spec 10.2).
    expect(production.assets?.run_worker_first).toEqual(['/api/*']);
    expect(production.assets?.not_found_handling).toBe('single-page-application');
    expect(production.assets?.binding).toBe('ASSETS');
  });
});

describe('the deployed worker', () => {
  it('is named, so it does not become dongfan-production by default', () => {
    expect(production.name).toBe(PRODUCTION_DATABASE);
  });
});

describe('reading a config with comments in it', () => {
  it('keeps the comments out and the URLs in', () => {
    const parsed = parseJsonc(`{
      // a comment
      "$schema": "https://example.com/schema.json", // trailing
      /* and a block */
      "list": [1, 2,],
    }`);

    expect(parsed).toEqual({ $schema: 'https://example.com/schema.json', list: [1, 2] });
  });
});
