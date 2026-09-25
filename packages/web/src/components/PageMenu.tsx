import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, House, Menu, Settings } from 'lucide-react';
import { zhTW } from '@dongfan/shared';

/**
 * The page list behind the icon at the top left (spec 7.10).
 *
 * A sheet rather than a drawer: it is opened one-handed, with a thumb, so
 * everything in it sits in the lower half of the screen even though the
 * button that opens it is at the top (spec 8).
 *
 * Plain links, so a page reached from here can be reloaded, shared and
 * bookmarked like any other. Nothing about which page is showing is kept
 * in state.
 */
export function PageMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const pages = [
    { to: '/', icon: House, label: zhTW.nav.home },
    { to: '/day', icon: CalendarDays, label: zhTW.nav.calendar },
    { to: '/settings', icon: Settings, label: zhTW.nav.settings },
  ];

  return (
    <>
      <button
        type="button"
        aria-label={zhTW.a11y.openMenu}
        onClick={() => setOpen(true)}
        data-testid="open-menu"
        className="flex size-11 items-center justify-center text-ink-muted"
      >
        <Menu size={22} />
      </button>

      {open ? (
        <div className="fixed inset-0 z-20 flex flex-col justify-end">
          {/* Dismissing by tapping away is the gesture people already have.
              A button as well, because a backdrop is not something a screen
              reader announces. */}
          <button
            type="button"
            aria-label={zhTW.nav.close}
            onClick={() => setOpen(false)}
            className="flex-1 bg-black/60"
          />
          <nav className="rounded-t-2xl border-t border-line bg-surface pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <p className="px-5 pb-1 text-xs tracking-widest text-ink-faint">{zhTW.nav.title}</p>
            {pages.map(({ to, icon: Icon, label }) => (
              <Link
                key={to}
                to={to}
                onClick={() => setOpen(false)}
                className="flex min-h-14 items-center gap-3 px-5 text-[15px] text-ink"
              >
                <Icon size={20} className="text-ink-faint" />
                {label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
