/**
 * One thing at a time, per scope.
 *
 * Four things ask for a sync: opening the app, coming back to the front,
 * coming back online, and finishing a write. Nothing stopped them
 * overlapping, and the one that finished last won -- which is not the one
 * that started last. A pull that set out before another and answered after
 * it would write its older view over the newer one and report success.
 *
 * A request made while one is running is not dropped either. Ignoring it
 * would lose exactly the case it exists for: a record written during a slow
 * pull, whose own refresh is the thing that would have shown it. At most one
 * follow-up is queued, and everything asking during a run joins that one,
 * because four requests to catch up are still one catching up.
 */

type Lane = {
  /** Resolves when everything currently accepted has finished. */
  tail: Promise<void>;
  /** The single queued follow-up, if something asked during a run. */
  waiting: Promise<void> | null;
};

const lanes = new Map<string, Lane>();

/** Swallows a rejection so one failure does not break the chain behind it. */
function quiet(task: Promise<void>): Promise<void> {
  return task.then(
    () => undefined,
    () => undefined,
  );
}

export function runExclusive(key: string, task: () => Promise<void>): Promise<void> {
  const existing = lanes.get(key);

  if (!existing) {
    const lane: Lane = { tail: Promise.resolve(), waiting: null };
    lanes.set(key, lane);

    const running = task();
    lane.tail = quiet(running).then(() => {
      // Nothing came in behind it, so the lane is finished with.
      if (lanes.get(key) === lane && lane.waiting === null) lanes.delete(key);
    });
    return running;
  }

  // Already queued: join it rather than adding another.
  if (existing.waiting) return existing.waiting;

  const waiting = existing.tail.then(() => {
    existing.waiting = null;
    return task();
  });
  existing.waiting = waiting;

  existing.tail = quiet(waiting).then(() => {
    if (lanes.get(key) === existing && existing.waiting === null) lanes.delete(key);
  });

  return waiting;
}

/** For tests, so one file's lanes cannot leak into the next. */
export function resetLanes(): void {
  lanes.clear();
}
