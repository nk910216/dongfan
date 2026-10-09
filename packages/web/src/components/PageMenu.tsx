import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarDays, CalendarRange, ChartColumn, House, Menu, Settings, Tags } from 'lucide-react';
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
  const { pathname } = useLocation();

  /** The six pages spec 7.10 names, in its order. */
  const pages = [
    { to: '/', icon: House, label: zhTW.nav.home, match: (p: string) => p === '/' },
    { to: '/day', icon: CalendarDays, label: zhTW.nav.calendar, match: (p: string) => p.startsWith('/day') },
    { to: '/two', icon: CalendarRange, label: zhTW.nav.twoDays, match: (p: string) => p.startsWith('/two') },
    { to: '/stats', icon: ChartColumn, label: zhTW.nav.stats, match: (p: string) => p.startsWith('/stats') },
    { to: '/tags', icon: Tags, label: zhTW.nav.tags, match: (p: string) => p.startsWith('/tags') },
    { to: '/settings', icon: Settings, label: zhTW.nav.settings, match: (p: string) => p.startsWith('/settings') },
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
            {pages.map(({ to, icon: Icon, label, match }) => {
              const here = match(pathname);
              return (
                <Link
                  key={to}
                  to={to}
                  onClick={() => setOpen(false)}
                  aria-current={here ? 'page' : undefined}
                  className={`flex min-h-14 items-center gap-3 px-5 text-[15px] ${
                    here ? 'text-accent' : 'text-ink'
                  }`}
                >
                  <Icon size={20} className={here ? 'text-accent' : 'text-ink-faint'} />
                  {label}
                  {/* Said as well as coloured: which page you are on is not
                      something to convey by hue alone (spec 7.10). */}
                  {here ? <span className="text-[11px] text-ink-dim">{zhTW.nav.current}</span> : null}
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}
    </>
  );
}
