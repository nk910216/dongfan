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

/**
 * Where an offer came from, which decides what it is worth.
 *
 * `worker` means a new build has installed and is waiting to take over;
 * taking it activates that worker and reloads onto the new bundle.
 *
 * `version` means the API reported a build this one is not, and nothing
 * more -- so all it can do is reload. While an old worker still controls
 * the page, a reload is served from its cache and comes back to the same
 * old bundle, which is why this one is the weaker of the two.
 */
type Source = 'worker' | 'version';

let pending: { apply: Apply; source: Source } | null = null;
let askWorker: (() => void) | null = null;
const listeners = new Set<() => void>();

/**
 * How to make the service worker go and look for a new build.
 *
 * Supplied by the registration. Absent where there is no worker at all --
 * a LAN address over plain HTTP, or a test -- and then nothing calls it.
 */
export function setWorkerCheck(check: () => void): void {
  askWorker = check;
}

/**
 * Says a newer build exists, and how to switch to it.
 *
 * A worker offer replaces a version offer, and never the other way round.
 * Keeping whichever arrived first would leave a plain reload standing in
 * for an activation: the old worker is still in control, the reload is
 * served from its cache, and the app comes back exactly as old with the
 * new one still waiting. Pressing the strip would do nothing, for ever.
 *
 * A version offer also sets the worker looking, so that in the ordinary
 * case the stronger offer has arrived by the time anybody presses
 * anything.
 */
export function offerUpdate(apply: Apply, source: Source = 'worker'): void {
  if (source === 'version') askWorker?.();

  const replaces = pending === null || (pending.source === 'version' && source === 'worker');
  if (!replaces) return;

  pending = { apply, source };
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
    pending?.apply();
  }, []);

  return { available, apply };
}

/** For tests, so one file's offer cannot leak into the next. */
export function resetUpdate(): void {
  pending = null;
  askWorker = null;
  for (const listener of listeners) listener();
  listeners.clear();
}
