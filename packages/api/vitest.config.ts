import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * Integration tests run inside the real Workers runtime against a real local
 * D1, not a mocked SQL layer. That is the only way the migrations, the
 * partial unique index and the CHECK constraint are actually exercised
 * (spec 11.2).
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    test: {
      name: 'api',
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: '2026-01-01',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
