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

/** The tail of each strict queue, for `runSerial` below. */
const chains = new Map<string, Promise<unknown>>();

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
  chains.clear();
}

/**
 * One at a time, per key, and every one of them runs.
 *
 * The difference from `runExclusive` is the whole reason both exist.
 * There, four requests to catch up collapse into one, because catching up
 * once is catching up. Here each task is a particular thing that has to
 * happen -- sending this record -- and collapsing two of them would mean
 * the second never ran at all while its caller was handed the first one's
 * promise and told it had finished.
 *
 * That mistake is not visible from the outside. The caller waits, gets a
 * resolved promise, and concludes that nothing happened to its entry.
 */
export function runSerial<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(task);

  // What the next caller waits on never rejects, so one failure does not
  // take the rest of the queue with it.
  const settled = quiet(result.then(() => undefined));
  chains.set(key, settled);
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key);
  });

  return result;
}
