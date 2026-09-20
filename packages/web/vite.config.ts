import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Resolve the shared package from source rather than its build output.
 *
 * Its package entry points at dist/, so a fresh checkout would fail to
 * resolve until something had built it, and during development an edit to
 * the event config would not reach the screen until a rebuild. Pointing at
 * the source removes both problems and gives shared code hot reload.
 */
const sharedSrc = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@dongfan/shared': sharedSrc } },
  server: {
    // Reachable from a phone on the same network for the spec 12.1 check.
    host: true,
    // A fixed, unusual port with strictPort: binding the default 5173 while
    // another project already holds it on [::1] lets both sockets exist, and
    // requests to localhost silently reach the other app. Failing loudly is
    // better than serving someone else's page.
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
