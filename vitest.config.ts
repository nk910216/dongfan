import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Same alias as the dev server: tests run against shared source, so they
  // never pass against a stale build.
  resolve: { alias: { '@dongfan/shared': sharedSrc } },
  test: {
    // The API suite is not listed here: it runs inside the Workers runtime
    // with its own pool and config, and is chained from the root test script.
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          include: ['packages/shared/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          // Maintenance scripts are plain Node modules, but a restore that
          // splits a dump wrongly corrupts data without failing, so the
          // parts that can be tested are.
          name: 'scripts',
          include: ['scripts/test/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          // Not only .tsx: the storage rules are plain functions, and
          // making them a component test to be collected would hide them.
          include: ['packages/web/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./packages/web/test/setup.ts'],
        },
      },
    ],
  },
});
