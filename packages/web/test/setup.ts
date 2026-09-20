import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { api, server } from './server.js';

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

installStorage();

// Vitest does not expose globals here, so Testing Library's automatic
// cleanup never registers. Without this every test renders on top of the
// previous one and queries start matching several copies of the app.
afterEach(cleanup);

// Requests are intercepted at the network boundary rather than by replacing
// the client. Stubbing our own fetch wrapper would remove the thing under
// test: whether the screen sends the body the contract describes.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  server.resetHandlers();
  api.reset();
  // A test may have left a Storage that throws in place.
  installStorage();
  localStorage.clear();
});

afterAll(() => server.close());
