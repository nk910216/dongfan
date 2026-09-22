/**
 * What build this is.
 *
 * A published PWA does not update when the server does. A service worker
 * serves the bundle it has cached until a new one has installed and taken
 * over, so the app a parent is looking at can be older than the API it is
 * talking to, for as long as they leave it open (spec 2.1).
 *
 * Two independent signals say a new build exists, and either is enough:
 * the service worker finding new assets, and this string differing from
 * what `GET /api/version` reports. The first is automatic and covers a
 * normal release; the second covers a session left open long enough that
 * nothing has gone looking, and is the one a deploy without a bump would
 * miss.
 *
 * Bumped by hand when a build is released. Both halves read it from here,
 * so they cannot disagree about what they are.
 */
export const APP_VERSION = '0.2.0';
