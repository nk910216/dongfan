import { useState } from 'react';
import { zhTW } from '@dongfan/shared';

/**
 * Asking an iPhone to keep the app on the home screen.
 *
 * WebKit clears script-writable storage for a site that has not been
 * opened for seven days, and a PWA added to the home screen is exempt.
 * Left in a Safari tab, this app loses the session, the local copy of the
 * records, the queue of unsent adds and the moment a timer was stopped at
 * -- all without saying anything (spec 9.6).
 *
 * So it is worth one strip that can be dismissed, not a dialog, and not
 * again once it has been.
 */

const DISMISSED = 'dongfan.install-hint-dismissed';

/**
 * iOS, and not already on the home screen.
 *
 * `navigator.standalone` is Safari's own answer and the only reliable one
 * on iOS; the media query is what every other browser answers. Neither is
 * asked on a platform that does not clear storage this way, because there
 * is nothing to warn about there.
 */
function shouldAsk(): boolean {
  try {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (!ios) return false;

    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;
    if (standalone) return false;

    return localStorage.getItem(DISMISSED) === null;
  } catch {
    // Every line above asks the browser something, and this is a hint. A
    // reading that throws -- storage refused in a private window, or an
    // embedded view without `matchMedia` -- must not take the home screen
    // down with it.
    return false;
  }
}

export function InstallHint(): React.JSX.Element | null {
  const [asking, setAsking] = useState(shouldAsk);

  if (!asking) return null;

  return (
    <div
      className="mx-3.5 mb-3 shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-3.5 py-2.5"
      data-testid="install-hint"
    >
      <p className="text-[13px] font-medium text-accent">{zhTW.install.title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{zhTW.install.body}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">{zhTW.install.how}</p>
      <button
        type="button"
        data-testid="install-hint-dismiss"
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED, '1');
          } catch {
            // It will be offered again next time, which is the harmless
            // way round.
          }
          setAsking(false);
        }}
        className="mt-2 min-h-11 text-[12px] text-ink-dim"
      >
        {zhTW.install.dismiss}
      </button>
    </div>
  );
}
