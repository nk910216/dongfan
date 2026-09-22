import { useEffect, useState } from 'react';
import { APP_VERSION, zhTW } from '@dongfan/shared';
import { apiRequest } from '../lib/api.js';
import { offerUpdate, useUpdate } from '../lib/update.js';

/**
 * "There is a new version, tap to take it."
 *
 * Two things can say so and either is enough. The service worker notices
 * new assets, which covers an ordinary release; and the API reports the
 * build it was deployed with, which covers a session left open long enough
 * that the worker has not gone looking -- exactly the phone that has been
 * on the bedside table since Tuesday (spec 2.1).
 *
 * It is a strip and not a dialog on purpose. A background check must never
 * interrupt somebody who is not even using the app (spec 7.11), and taking
 * the update reloads the page, which is not a thing to do to a parent
 * mid-sentence without asking.
 */
export function UpdateBanner(): React.JSX.Element | null {
  const { available, apply } = useUpdate();
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') return;
      try {
        const body = await apiRequest<{ version: string }>('/version');
        // Different, not newer: this build has no way to order two version
        // strings, and "not what the server is serving" is the thing worth
        // saying either way.
        if (!cancelled && body.version !== APP_VERSION) {
          offerUpdate(() => window.location.reload());
        }
      } catch {
        // Being unable to ask says nothing about whether there is a new
        // build, and the app works offline. Silent on purpose.
      }
    };

    const again = (): void => void check();

    void check();
    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);

    return () => {
      cancelled = true;
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, []);

  if (!available) return null;

  return (
    <button
      type="button"
      disabled={applying}
      data-testid="update-available"
      onClick={() => {
        setApplying(true);
        apply();
      }}
      className="flex w-full shrink-0 items-baseline justify-center gap-2 bg-accent px-4 py-2 text-[13px] font-bold text-ground disabled:opacity-70"
    >
      <span>{applying ? zhTW.update.applying : zhTW.update.available}</span>
      <span className="text-[11px] font-medium opacity-80">{zhTW.update.keepsDraft}</span>
    </button>
  );
}
