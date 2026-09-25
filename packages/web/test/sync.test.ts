import { beforeEach, describe, expect, it } from 'vitest';
import type { EventDto, EventPageDto } from '@dongfan/shared';
import type { SummaryDto } from '@dongfan/shared';
import { localToUtc } from '@dongfan/shared';
import {
  allEvents, applyPage, calendarDay, db, eventsOnDate, findEvent, readMeta, scopeOf, writeSummary,
} from '../src/lib/db.js';
import { syncEvents } from '../src/lib/sync.js';

/**
 * The local database and the pull that fills it.
 *
 * Every mistake available here is silent. A cursor that moves without its
 * rows leaves a gap nothing will ever ask for again; a row accepted over a
 * newer one loses an edit; a scope left off a query shows one family the
 * other's records. None of them throw, and none of them look wrong on
 * screen (spec 5.4, 6.2).
 */

const MINE = scopeOf('user-1', 'baby-1');
const THEIRS = scopeOf('user-2', 'baby-2');

function event(id: string, rev: number, over: Partial<EventDto> = {}): EventDto {
  return {
    id,
    babyId: 'baby-1',
    typeId: 'bottle',
    createdBy: 'user-1',
    createdAt: 1_789_000_000_000,
    updatedAt: 1_789_000_000_000,
    startedAt: 1_789_000_000_000,
    endedAt: null,
    localDate: '2026-09-20',
    value: 120,
    note: '',
    metadata: {},
    version: 1,
    rev,
    active: false,
    deletedAt: null,
    tagIds: [],
    ...over,
  };
}

describe('holding events', () => {
  it('keeps what was applied and moves the cursor with it', async () => {
    await applyPage(MINE, [event('a', 1), event('b', 2)], 2);

    expect((await allEvents(MINE)).map((e) => e.id)).toEqual(['a', 'b']);
    expect((await readMeta(MINE)).cursor).toBe(2);
  });

  it('starts from the beginning when nothing has been pulled', async () => {
    // Zero, not null: it is sent straight back as `since` (spec 5.4).
    expect((await readMeta(MINE)).cursor).toBe(0);
  });

  it('takes a newer version of an event it already has', async () => {
    await applyPage(MINE, [event('a', 1, { value: 120 })], 1);
    await applyPage(MINE, [event('a', 5, { value: 150 })], 5);

    expect((await findEvent(MINE, 'a'))?.value).toBe(150);
  });

  it('ignores an older one, however late it turns up', async () => {
    await applyPage(MINE, [event('a', 5, { value: 150 })], 5);
    // A reply from a request made before the last one, arriving after it.
    await applyPage(MINE, [event('a', 1, { value: 120 })], 5);

    expect((await findEvent(MINE, 'a'))?.value).toBe(150);
  });

  it('ignores one at the same rev, which is the same row', async () => {
    await applyPage(MINE, [event('a', 3, { value: 150 })], 3);
    await applyPage(MINE, [event('a', 3, { value: 999 })], 3);

    expect((await findEvent(MINE, 'a'))?.value).toBe(150);
  });
});

describe('deletions', () => {
  it('hides a tombstone without forgetting it', async () => {
    await applyPage(MINE, [event('a', 1)], 1);
    await applyPage(MINE, [event('a', 4, { deletedAt: 1_789_000_100_000 })], 4);

    expect(await findEvent(MINE, 'a')).toBeNull();
    expect(await eventsOnDate(MINE, '2026-09-20')).toEqual([]);
    // The row itself stays, and so does its rev.
    expect((await allEvents(MINE)).map((e) => e.rev)).toEqual([4]);
  });

  it('does not let a late reply bring a deleted event back', async () => {
    await applyPage(MINE, [event('a', 1)], 1);
    await applyPage(MINE, [event('a', 4, { deletedAt: 1_789_000_100_000 })], 4);

    // Dropping the row on deletion would drop its rev with it, and this
    // would then look like a row we had never seen (spec 6.2).
    await applyPage(MINE, [event('a', 2)], 4);

    expect(await findEvent(MINE, 'a')).toBeNull();
  });
});

describe('one day at a time', () => {
  it('returns that day, newest first, and nothing else', async () => {
    await applyPage(MINE, [
      event('early', 1, { startedAt: 1_789_000_000_000 }),
      event('late', 2, { startedAt: 1_789_000_900_000 }),
      event('other-day', 3, { localDate: '2026-09-19' }),
    ], 3);

    expect((await eventsOnDate(MINE, '2026-09-20')).map((e) => e.id)).toEqual(['late', 'early']);
  });

  it('breaks a tie on the id, so the order does not wobble', async () => {
    const at = 1_789_000_500_000;
    await applyPage(MINE, [event('aaa', 1, { startedAt: at }), event('bbb', 2, { startedAt: at })], 2);

    const first = (await eventsOnDate(MINE, '2026-09-20')).map((e) => e.id);
    const again = (await eventsOnDate(MINE, '2026-09-20')).map((e) => e.id);
    expect(first).toEqual(again);
    expect(first).toEqual(['bbb', 'aaa']);
  });
});

describe('a day on the calendar', () => {
  const TAIPEI = 'Asia/Taipei';

  /** An instant from a Taipei wall clock, so the dates are readable. */
  const at = (day: number, hour: number, minute = 0): number =>
    localToUtc({ year: 2026, month: 9, day, hour, minute }, TAIPEI);

  const overnight = (): EventDto =>
    event('overnight', 1, {
      typeId: 'sleep',
      localDate: '2026-09-20',
      startedAt: at(20, 23, 10),
      endedAt: at(21, 7, 5),
    });

  const breakfast = (): EventDto =>
    event('breakfast', 2, {
      localDate: '2026-09-21',
      startedAt: at(21, 8),
      endedAt: at(21, 8, 20),
    });

  it('shows the sleep that began before midnight, and says it was carried over', async () => {
    await applyPage(MINE, [overnight(), breakfast()], 2);

    const day = await calendarDay(MINE, '2026-09-21', TAIPEI);

    expect(day.map((e) => e.event.id)).toEqual(['breakfast', 'overnight']);
    expect(day[1]).toMatchObject({ carriedOver: true, msOnDay: 7 * 3_600_000 + 5 * 60_000 });
    expect(day[0]).toMatchObject({ carriedOver: false, msOnDay: 20 * 60_000 });
  });

  it('puts an all-day event above everything, whatever the clock says', async () => {
    // Its instant is local midnight, because that is what the server
    // stores for an all-day event (spec 3.9). Sorted by the clock it
    // would sink beneath every feed of the day, which is the opposite of
    // what a milestone is for.
    await applyPage(MINE, [
      breakfast(),
      event('milestone', 3, {
        typeId: 'milestone',
        localDate: '2026-09-21',
        startedAt: at(21, 0),
        endedAt: null,
      }),
    ], 3);

    expect((await calendarDay(MINE, '2026-09-21', TAIPEI)).map((e) => e.event.id))
      .toEqual(['milestone', 'breakfast']);
  });

  it('gives the earlier day only the minutes that were actually its own', async () => {
    await applyPage(MINE, [overnight()], 1);

    const day = await calendarDay(MINE, '2026-09-20', TAIPEI);

    expect(day.map((e) => e.event.id)).toEqual(['overnight']);
    expect(day[0]).toMatchObject({ carriedOver: false, msOnDay: 50 * 60_000 });
  });

  it('is the one thing it differs from the home screen list by', async () => {
    // Not an accident. `eventsOnDate` answers "what is counted on this
    // day", which is what the figures beside it are computed from; the
    // calendar answers "what was happening". The overnight sleep is the
    // only case where those two are not the same list.
    await applyPage(MINE, [overnight(), breakfast()], 2);

    expect((await eventsOnDate(MINE, '2026-09-21')).map((e) => e.id)).toEqual(['breakfast']);
    expect((await calendarDay(MINE, '2026-09-21', TAIPEI)).map((e) => e.event.id))
      .toEqual(['breakfast', 'overnight']);
  });

  it('shows a timer that is still running on its own day and no later one', async () => {
    // Zero minutes is not absent. A sleep started at 23:10 and never
    // stopped belongs to the 20th, and putting it on the 21st as well
    // would have it appear twice for as long as it runs.
    await applyPage(MINE, [
      event('running', 1, {
        typeId: 'sleep',
        localDate: '2026-09-20',
        startedAt: at(20, 23, 10),
        endedAt: null,
        active: true,
      }),
    ], 1);

    expect((await calendarDay(MINE, '2026-09-20', TAIPEI)).map((e) => e.event.id))
      .toEqual(['running']);
    expect(await calendarDay(MINE, '2026-09-21', TAIPEI)).toEqual([]);
  });

  it('does not reach back further than the day before', async () => {
    // It looks at one earlier day because an event lasts at most 24 hours
    // and so crosses midnight at most once. Anything older cannot reach.
    await applyPage(MINE, [
      event('two-days-ago', 1, { localDate: '2026-09-19', startedAt: at(19, 10), endedAt: at(19, 11) }),
    ], 1);

    expect(await calendarDay(MINE, '2026-09-21', TAIPEI)).toEqual([]);
  });

  it('leaves out a deleted event that would otherwise have carried over', async () => {
    await applyPage(MINE, [{ ...overnight(), deletedAt: at(21, 9) }], 1);

    expect(await calendarDay(MINE, '2026-09-21', TAIPEI)).toEqual([]);
  });

  it('does not show one account the other’s night', async () => {
    await applyPage(THEIRS, [overnight()], 1);

    expect(await calendarDay(MINE, '2026-09-21', TAIPEI)).toEqual([]);
    expect((await calendarDay(THEIRS, '2026-09-21', TAIPEI)).map((e) => e.event.id))
      .toEqual(['overnight']);
  });
});

describe('keeping accounts apart', () => {
  beforeEach(async () => {
    await applyPage(MINE, [event('mine', 1, { note: 'ours' })], 1);
    await applyPage(THEIRS, [event('theirs', 1, { note: 'someone else' })], 1);
  });

  it('shows one scope nothing of the other', async () => {
    expect((await allEvents(MINE)).map((e) => e.id)).toEqual(['mine']);
    expect((await eventsOnDate(THEIRS, '2026-09-20')).map((e) => e.id)).toEqual(['theirs']);
  });

  it('will not find another scope’s event by id', async () => {
    expect(await findEvent(MINE, 'theirs')).toBeNull();
  });

  it('keeps a cursor per scope', async () => {
    await applyPage(MINE, [event('more', 9)], 9);

    // A shared cursor would make one baby's sync skip the other's
    // history, permanently.
    expect((await readMeta(MINE)).cursor).toBe(9);
    expect((await readMeta(THEIRS)).cursor).toBe(1);
  });
});

describe('a reply that set out earlier and arrived later', () => {
  function summary(totalBottleMl: number): SummaryDto {
    return {
      date: '2026-09-20',
      types: [],
      today: { totalBottleMl, diaper: { pee: 0, poo: 0, both: 0, unknown: 0, total: 0 } },
      lastFeedAt: null,
    };
  }

  it('cannot move the cursor backwards', async () => {
    await applyPage(MINE, [event('a', 10)], 10);
    // A page from a request made before that one, answering after it.
    await applyPage(MINE, [event('b', 5)], 5);

    // Left at five, every later sync would ask for six onwards again --
    // for ever, and with nothing to show that it was happening.
    expect((await readMeta(MINE)).cursor).toBe(10);
  });

  it('still keeps the rows that late page carried', async () => {
    await applyPage(MINE, [event('a', 10)], 10);
    await applyPage(MINE, [event('b', 5)], 5);

    // The cursor not moving back is not a reason to throw the events away:
    // they are rows we did not have.
    expect((await allEvents(MINE)).map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('cannot write an older summary over a newer one', async () => {
    await writeSummary(MINE, summary(240), 10);
    await writeSummary(MINE, summary(120), 5);

    // The figures going backwards while the header says the sync just
    // succeeded is the worst of both.
    expect((await readMeta(MINE)).summary?.today.totalBottleMl).toBe(240);
  });

  it('takes a summary fetched at the same point, because today moves', async () => {
    await writeSummary(MINE, summary(240), 10);
    await writeSummary(MINE, summary(300), 10);

    // Two pulls that found nothing new still describe different moments.
    expect((await readMeta(MINE)).summary?.today.totalBottleMl).toBe(300);
  });

  it('takes the first summary there has ever been', async () => {
    await writeSummary(MINE, summary(120), 0);
    expect((await readMeta(MINE)).summary?.today.totalBottleMl).toBe(120);
  });
});

describe('a record written by an older build', () => {
  function summary(totalBottleMl: number): SummaryDto {
    return {
      date: '2026-09-20',
      types: [],
      today: { totalBottleMl, diaper: { pee: 0, poo: 0, both: 0, unknown: 0, total: 0 } },
      lastFeedAt: null,
    };
  }

  /** The shape before summaries carried the cursor they were fetched at. */
  async function writeLegacyMeta(): Promise<void> {
    const database = await db();
    await database.put('meta', {
      scope: MINE,
      cursor: 5,
      syncedAt: 1_789_000_000_000,
      summary: summary(120),
      summaryAt: 1_789_000_000_000,
    } as never);
  }

  it('can still store a new summary', async () => {
    await writeLegacyMeta();

    // Comparing a number against a field that is not there is false, not
    // an error, so without a default the summary on a phone that had
    // already used the app could never be replaced again.
    await writeSummary(MINE, summary(240), 10);

    expect((await readMeta(MINE)).summary?.today.totalBottleMl).toBe(240);
  });

  it('hands back the summary it stored, not the one it was given', async () => {
    await writeSummary(MINE, summary(240), 10);

    // A refused reply must not be returned either: the caller would put it
    // on screen and the database would quietly disagree.
    const stored = await writeSummary(MINE, summary(120), 5);
    expect(stored.today.totalBottleMl).toBe(240);
  });

  it('keeps the cursor and the events it already had', async () => {
    await writeLegacyMeta();
    await applyPage(MINE, [event('a', 8)], 8);

    // Filling in a missing field must not cost anything that was there.
    expect((await readMeta(MINE)).cursor).toBe(8);
    expect((await allEvents(MINE)).map((e) => e.id)).toEqual(['a']);
  });

  it('does not let the missing field drag the cursor back', async () => {
    await writeLegacyMeta();
    await applyPage(MINE, [event('a', 2)], 2);

    expect((await readMeta(MINE)).cursor).toBe(5);
  });
});

describe('pulling from the server', () => {
  /** A feed of pages, handed out in order. */
  function feed(pages: EventPageDto[]) {
    const asked: string[] = [];
    let next = 0;
    const fetch = <T,>(path: string): Promise<T> => {
      asked.push(path);
      const page = pages[next] ?? { events: [], nextRev: 0, hasMore: false };
      next += 1;
      return Promise.resolve(page as T);
    };
    return { fetch, asked };
  }

  it('asks from the cursor it holds', async () => {
    await applyPage(MINE, [event('a', 7)], 7);
    const { fetch, asked } = feed([{ events: [], nextRev: 7, hasMore: false }]);

    await syncEvents(MINE, 'baby-1', fetch);

    expect(asked[0]).toContain('since=7');
  });

  it('keeps going while the server says there is more', async () => {
    const { fetch, asked } = feed([
      { events: [event('a', 1), event('b', 2)], nextRev: 2, hasMore: true },
      { events: [event('c', 3)], nextRev: 3, hasMore: false },
    ]);

    const result = await syncEvents(MINE, 'baby-1', fetch);

    // Stopping at a full page would leave the rest unasked for until
    // something else happened to trigger a sync (spec 5.4).
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('since=2');
    expect(result.applied).toBe(3);
    expect((await allEvents(MINE)).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the cursor where the last good page ended', async () => {
    let call = 0;
    const fetch = <T,>(): Promise<T> => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ events: [event('a', 1)], nextRev: 1, hasMore: true } as T);
      }
      return Promise.reject(new Error('the train went into a tunnel'));
    };

    await expect(syncEvents(MINE, 'baby-1', fetch)).rejects.toThrow();

    // The first page is here and the cursor is at its end, so the next
    // attempt continues rather than starting over -- and nothing between
    // the old cursor and the new one was skipped.
    expect((await allEvents(MINE)).map((e) => e.id)).toEqual(['a']);
    expect((await readMeta(MINE)).cursor).toBe(1);
  });

  it('holds the cursor still when there is nothing new', async () => {
    await applyPage(MINE, [event('a', 4)], 4);
    const { fetch } = feed([{ events: [], nextRev: 4, hasMore: false }]);

    await syncEvents(MINE, 'baby-1', fetch);

    expect((await readMeta(MINE)).cursor).toBe(4);
  });

  it('gives up rather than looping forever on a server that never stops', async () => {
    const fetch = <T,>(): Promise<T> =>
      Promise.resolve({ events: [], nextRev: 1, hasMore: true } as T);

    await expect(syncEvents(MINE, 'baby-1', fetch)).rejects.toThrow(/kept reporting more/);
  });
});
