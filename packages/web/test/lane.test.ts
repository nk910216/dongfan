import { beforeEach, describe, expect, it } from 'vitest';
import { resetLanes, runExclusive, runSerial } from '../src/lib/lane.js';

/**
 * Keeping overlapping work out of each other's way.
 *
 * Four things ask for a sync and none of them knows about the others. When
 * two run together the one that answers last wins, and that is not the one
 * that asked last: a pull that set out earlier and came back later writes
 * its older view over the newer one and reports success (spec 6.2).
 */

/** A task that finishes when the test says so. */
function deferred() {
  let release = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { done, release: () => release() };
}

beforeEach(() => resetLanes());

describe('one at a time', () => {
  it('does not start a second while the first is running', async () => {
    const first = deferred();
    const order: string[] = [];

    const a = runExclusive('baby', async () => {
      order.push('a:start');
      await first.done;
      order.push('a:end');
    });
    const b = runExclusive('baby', async () => {
      order.push('b:start');
    });

    // b must not have begun while a is still in flight.
    expect(order).toEqual(['a:start']);

    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('runs different scopes side by side', async () => {
    const held = deferred();
    const order: string[] = [];

    const mine = runExclusive('baby-1', async () => {
      order.push('mine');
      await held.done;
    });
    const theirs = runExclusive('baby-2', async () => {
      order.push('theirs');
    });

    // One baby's slow pull must not hold up another's.
    await theirs;
    expect(order).toEqual(['mine', 'theirs']);

    held.release();
    await mine;
  });
});

describe('asking during a run', () => {
  it('is queued rather than dropped', async () => {
    const first = deferred();
    let runs = 0;

    const a = runExclusive('baby', async () => {
      runs += 1;
      await first.done;
    });
    const b = runExclusive('baby', async () => {
      runs += 1;
    });

    first.release();
    await Promise.all([a, b]);

    // Dropping it would lose the case this exists for: a record written
    // during a slow pull, whose own refresh is what would have shown it.
    expect(runs).toBe(2);
  });

  it('collapses several waiting requests into one', async () => {
    const first = deferred();
    let runs = 0;

    const a = runExclusive('baby', async () => {
      runs += 1;
      await first.done;
    });
    const rest = [
      runExclusive('baby', async () => { runs += 1; }),
      runExclusive('baby', async () => { runs += 1; }),
      runExclusive('baby', async () => { runs += 1; }),
    ];

    first.release();
    await Promise.all([a, ...rest]);

    // Four requests to catch up are still one catching up.
    expect(runs).toBe(2);
  });

  it('waits for the follow-up, not just the run in progress', async () => {
    const first = deferred();
    const second = deferred();
    let finished = false;

    const a = runExclusive('baby', async () => { await first.done; });
    const b = runExclusive('baby', async () => {
      await second.done;
      finished = true;
    });

    first.release();
    await a;
    expect(finished).toBe(false);

    second.release();
    await b;
    expect(finished).toBe(true);
  });
});

describe('when one fails', () => {
  it('still runs what was queued behind it', async () => {
    const first = deferred();
    let ranSecond = false;

    const a = runExclusive('baby', async () => {
      await first.done;
      throw new Error('the train went into a tunnel');
    });
    const b = runExclusive('baby', async () => { ranSecond = true; });

    first.release();
    await expect(a).rejects.toThrow();
    await b;

    expect(ranSecond).toBe(true);
  });

  it('lets the next request start cleanly afterwards', async () => {
    await expect(
      runExclusive('baby', () => Promise.reject(new Error('no'))),
    ).rejects.toThrow();

    let ran = false;
    await runExclusive('baby', async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

/**
 * The other primitive, and the reason there are two.
 *
 * `runExclusive` collapses requests that arrive during a run, because four
 * requests to catch up are one catching up. `runSerial` cannot: each of
 * its tasks is a particular record being sent, and a task that was
 * collapsed into somebody else's never happens at all -- while its caller
 * is handed the other one's promise and concludes that it did.
 *
 * That is not a theory. Sending was written on the collapsing one first,
 * and a save made while the queue happened to be running was silently
 * dropped, the screen reporting that nothing had gone wrong.
 */
describe('a queue where every task matters', () => {
  it('runs all of them, including ones that arrive together', async () => {
    const first = deferred();
    const ran: number[] = [];

    const a = runSerial('outbox', async () => {
      await first.done;
      ran.push(1);
    });
    const b = runSerial('outbox', () => Promise.resolve(ran.push(2)));
    const c = runSerial('outbox', () => Promise.resolve(ran.push(3)));

    first.release();
    await Promise.all([a, b, c]);

    // The same three through `runExclusive` would be two: the third joins
    // the second and never runs.
    expect(ran).toEqual([1, 2, 3]);
  });

  it('is not the collapsing one', async () => {
    const first = deferred();
    let collapsed = 0;
    let serial = 0;

    const a = runExclusive('sync', async () => { await first.done; });
    const b = runExclusive('sync', () => Promise.resolve(void (collapsed += 1)));
    const c = runExclusive('sync', () => Promise.resolve(void (collapsed += 1)));

    const d = runSerial('send', async () => { await first.done; });
    const e = runSerial('send', () => Promise.resolve(void (serial += 1)));
    const f = runSerial('send', () => Promise.resolve(void (serial += 1)));

    first.release();
    await Promise.all([a, b, c, d, e, f]);

    expect(collapsed).toBe(1);
    expect(serial).toBe(2);
  });

  it('does not let two run at once', async () => {
    const first = deferred();
    let running = 0;
    let most = 0;

    const watch = async (): Promise<void> => {
      running += 1;
      most = Math.max(most, running);
      await first.done;
      running -= 1;
    };

    const a = runSerial('outbox', watch);
    const b = runSerial('outbox', watch);
    first.release();
    await Promise.all([a, b]);

    expect(most).toBe(1);
  });

  it('hands each caller its own answer', async () => {
    const [a, b] = await Promise.all([
      runSerial('outbox', () => Promise.resolve('first')),
      runSerial('outbox', () => Promise.resolve('second')),
    ]);

    // Handing the second caller the first one's result is how a send that
    // never happened comes to look like one that did.
    expect([a, b]).toEqual(['first', 'second']);
  });

  it('still runs what was behind a task that threw', async () => {
    const ran: string[] = [];

    const failed = runSerial('outbox', () => Promise.reject(new Error('no')));
    const after = runSerial('outbox', () => Promise.resolve(void ran.push('after')));

    await expect(failed).rejects.toThrow('no');
    await after;

    expect(ran).toEqual(['after']);
  });
});
