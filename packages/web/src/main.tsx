import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { zhTW } from '@dongfan/shared';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import { offerUpdate, setWorkerCheck } from './lib/update.js';
import './index.css';

// Set here rather than in index.html so every Chinese string stays in the
// copy file and the language check keeps a single whitelist (spec 13.1).
document.title = zhTW.app.name;

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/**
 * The service worker, registered here and nowhere else.
 *
 * Not by the plugin's own injected snippet, so that what happens when a
 * new build arrives is written where somebody will read it. Nothing is
 * taken automatically: `updateSW(true)` runs only when a parent presses
 * the strip at the top of the screen, because taking an update reloads the
 * page and they may be part way through a feed (spec 2.1).
 *
 * Only in a secure context. On a LAN address over plain HTTP there is no
 * service worker to register, and the rest of the app carries on without
 * one (spec 10.1).
 */
const updateSW = registerSW({
  onNeedRefresh() {
    offerUpdate(() => void updateSW(true), 'worker');
  },
  onRegisteredSW(_url, registration) {
    // How the version check asks the worker to go and look. Without it,
    // an app that learns from the API that it is behind can only reload --
    // and a reload while this worker is still in control is served from
    // its cache and comes back just as old.
    if (registration) setWorkerCheck(() => void registration.update());
  },
});

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
