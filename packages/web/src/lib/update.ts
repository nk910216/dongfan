import { useCallback, useSyncExternalStore } from 'react';

/**
 * Knowing that a newer build exists, and taking it only when asked.
 *
 * A service worker keeps serving the bundle it has until a new one has
 * installed *and* taken over, so an app left open is older than the API it
 * is talking to and stays that way. Letting the new one take over by
 * itself is worse: the page reloads under whoever is holding the phone,
 * and at three in the morning that is a half-typed feed thrown away. So it
 * asks (spec 2.1).
 *
 * Nothing here decides *how* to take the update. The service worker
 * registration supplies that, which keeps this file free of anything a
 * test environment does not have.
 */

type Apply = () => void;

let pending: Apply | null = null;
const listeners = new Set<() => void>();

/**
 * Says a newer build is ready, and how to switch to it.
 *
 * Called by the service worker registration when a new one is waiting, and
 * by the version check when the API reports a build this one is not. The
 * first offer wins: a second signal about the same release would otherwise
 * replace a working switch with another one for no reason.
 */
export function offerUpdate(apply: Apply): void {
  if (pending) return;
  pending = apply;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isAvailable = (): boolean => pending !== null;

/** Never on the server, where there is no service worker to hear from. */
const neverAvailable = (): boolean => false;

export function useUpdate(): { available: boolean; apply: () => void } {
  const available = useSyncExternalStore(subscribe, isAvailable, neverAvailable);

  const apply = useCallback(() => {
    // Nothing is saved here on the way out. What a parent has typed is
    // written down as they type it, because the reload that loses it is
    // just as likely to come from the browser as from this button.
    pending?.();
  }, []);

  return { available, apply };
}

/** For tests, so one file's offer cannot leak into the next. */
export function resetUpdate(): void {
  pending = null;
  for (const listener of listeners) listener();
  listeners.clear();
}
