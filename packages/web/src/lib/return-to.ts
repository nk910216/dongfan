import { useSearchParams } from 'react-router-dom';

/**
 * Where a screen opened from somewhere else should go back to.
 *
 * Carried in the query string, not in router state or the history stack. A
 * reload must not lose it -- state does, and `navigate(-1)` has nothing to go
 * to when a link was opened directly -- and the same rule already carries the
 * day a record is being filed under (spec 2.1).
 *
 * The screens reached from the home screen do not use it: home is where '/'
 * already goes. It exists because tapping a record on the calendar and coming
 * back put a parent on the home screen, on today, with whatever they had
 * opened on the day they were reading closed again.
 */
const KEY = 'from';

/** Appends the current location, for a link that leads away from it. */
export function linkBack(to: string, from: string): string {
  const joiner = to.includes('?') ? '&' : '?';
  return `${to}${joiner}${KEY}=${encodeURIComponent(from)}`;
}

/**
 * The path to return to, or the home screen.
 *
 * Only a path within the app: anything that is not one is ignored rather
 * than followed, so a crafted link cannot send somebody off the site.
 */
export function useReturnTo(): string {
  const [search] = useSearchParams();
  const asked = search.get(KEY);
  if (asked === null || !asked.startsWith('/') || asked.startsWith('//')) return '/';
  return asked;
}
