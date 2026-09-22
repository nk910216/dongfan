import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api, server } from './server.js';
import { closeDb } from '../src/lib/db.js';
import { resetLanes } from '../src/lib/lane.js';
import { resetMigration } from '../src/lib/outbox.js';
import { resetUpdate } from '../src/lib/update.js';

/**
 * A working Storage for the tests.
 *
 * Node 25 ships its own `localStorage` global, inert without
 * `--localstorage-file`, and it shadows the one jsdom installs: the object
 * is there but `setItem` is not a function. The app already survives that,
 * because every access is wrapped, but then nothing about remembering a
 * session could be tested at all. A browser has a real Storage, so the
 * tests get one too.
 */
export function installStorage(): void {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, String(value)),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };

  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', { value: storage, configurable: true });
  }
}

/**
 * A Storage that refuses everything, as a private window or a device with
 * site data blocked would.
 *
 * Signing in has to keep working without it: the token lives in memory too,
 * and anything that reads it back from storage instead would find nothing.
 */
export function breakStorage(): void {
  const refuse = (): never => {
    throw new DOMException('storage is unavailable', 'SecurityError');
  };
  const storage = {
    get length(): number {
      return refuse();
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  } as unknown as Storage;

  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', { value: storage, configurable: true });
  }
}

/**
 * Flight mode, and back out of it.
 *
 * The app asks `navigator.onLine` before sending an add, because a `false`
 * there means nothing can have left the device -- which is what lets a
 * queued record still be corrected later (spec 6.1).
 */
export function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
}

/**
 * jsdom does not implement `matchMedia`, and every browser does.
 *
 * Supplied rather than guarded around, so the screens run the same code
 * here as on a phone. Nothing under test asks it anything but whether the
 * app is running from the home screen, which in a test it is not.
 */
function installMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

installMatchMedia();
installStorage();

/**
 * Waits until the app has stopped talking to the server.
 *
 * A test finishes as soon as its assertions pass, which is usually while
 * the app is still working: a pull, a write and the queue's own run all
 * carry on afterwards. Anything still in the air when the next test starts
 * is served by that test's stubs, reads that test's database, and eats the
 * one-shot behaviour it armed for itself -- "lose the next response" being
 * the one that caused this. The failure lands in the next test, which is
 * the worst place for it.
 *
 * Several consecutive ticks with no new request are the signal, not one:
 * the chains here go through IndexedDB between requests, so a single quiet
 * tick is regularly the gap between two halves of the same run. The app is
 * unmounted by the time this is called, so nothing new can be started.
 */
async function settleInFlight(): Promise<void> {
  let quiet = 0;
  let seen = -1;

  for (let i = 0; i < 60 && quiet < 4; i += 1) {
    quiet = api.requests.length === seen ? quiet + 1 : 0;
    seen = api.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// Requests are intercepted at the network boundary rather than by replacing
// the client. Stubbing our own fetch wrapper would remove the thing under
// test: whether the screen sends the body the contract describes.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(async () => {
  // Vitest does not expose globals here, so Testing Library's automatic
  // cleanup never registers. Without this every test renders on top of the
  // previous one and queries start matching several copies of the app.
  //
  // First, so that the app stops scheduling more work before anything is
  // taken away from underneath it.
  cleanup();
  await settleInFlight();

  server.resetHandlers();
  api.reset();

  // A brand new IndexedDB for every test. Emptying the stores would leave
  // whatever the previous test's sync cursor was, and a cursor is exactly
  // the thing that makes a sync quietly return nothing.
  resetLanes();
  // The move out of the old store runs once per load. Without this, one
  // test's migration would count as the next one's.
  resetMigration();
  // A build offered in one test must not still be on offer in the next.
  resetUpdate();
  setOnline(true);
  closeDb();
  globalThis.indexedDB = new IDBFactory();
  // A test may have left a Storage that throws in place.
  installStorage();
  localStorage.clear();
});

afterAll(() => server.close());
