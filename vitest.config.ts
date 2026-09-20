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
          name: 'web',
          include: ['packages/web/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./packages/web/test/setup.ts'],
        },
      },
    ],
  },
});
