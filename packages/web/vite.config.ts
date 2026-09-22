import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

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
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Never take over on its own. A new build that installs itself
      // reloads the page under whoever is using it, and at three in the
      // morning that is a half-typed feed thrown away. The app asks first
      // (spec 2.1).
      registerType: 'prompt',
      // Registered by hand in main.tsx, so that what happens when an
      // update is ready is written where it can be read.
      injectRegister: null,
      manifest: {
        name: 'dongfan',
        short_name: 'dongfan',
        description: 'Baby care records',
        lang: 'zh-Hant',
        start_url: '/',
        scope: '/',
        // What exempts iOS from clearing storage after seven days, which
        // would take unsent records with it (spec 9.6).
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#13110E',
        theme_color: '#13110E',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The shell, so the app starts with no network at all. Fonts come
        // from a CDN and are left to the browser: precaching them would
        // mean the first load fetches everything twice.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/index.html',
        // The API is never served from the cache. A stale answer here is
        // not a slow app, it is the wrong records on screen, and the sync
        // cursor would move over data that was never fetched (spec 6.2).
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        // Off in dev: a service worker caching a dev bundle turns every
        // edit into a puzzle. It is exercised against a real build, which
        // is the only place it behaves like the deployed one.
        enabled: false,
      },
    }),
  ],
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
