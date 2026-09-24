/**
 * A best-effort brake, held in memory.
 *
 * Spec 9.4 settled this shape for the whole project and the reasoning is
 * worth repeating where it is used: a counter in a table turns anybody's
 * traffic into database writes, and once the free plan's daily write
 * allowance is gone *every* query fails until midnight UTC. A brake that
 * can be used to stop a parent recording a feed is worse than the thing it
 * was protecting.
 *
 * So this counts in the isolate and writes nothing. It is genuinely
 * unreliable -- isolates come and go, and there may be several at once --
 * and nothing may be argued to be safe because of it. What it does is make
 * guessing at a code from one place pointlessly slow, which is all it is
 * for. The real defence is that there are 150 bits to guess (spec 6.5).
 */

type Window = { count: number; until: number };

const windows = new Map<string, Window>();

/**
 * Bounded, because the keys come from outside.
 *
 * An isolate that lived a long time under a spray of requests would
 * otherwise keep a row per key for ever. Well past anything a family
 * produces, and dropping the oldest costs nothing but a slower brake.
 */
const MAX_KEYS = 1000;

export type Limit = { attempts: number; windowMs: number };

/**
 * Records an attempt and says whether it is over the line.
 *
 * Counted before the work rather than after the failure: an attempt that
 * succeeds is one attempt too, and letting success reset the count is how
 * a brake is walked around.
 */
export function overLimit(key: string, limit: Limit, now: number = Date.now()): boolean {
  const found = windows.get(key);

  if (!found || found.until <= now) {
    if (windows.size >= MAX_KEYS) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    windows.set(key, { count: 1, until: now + limit.windowMs });
    return false;
  }

  found.count += 1;
  return found.count > limit.attempts;
}

/** For tests, and for nothing else: there is no production reason to forget. */
export function resetThrottle(): void {
  windows.clear();
}
