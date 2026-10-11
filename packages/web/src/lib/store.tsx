import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getEventType, toLocalDate, zhTW } from '@dongfan/shared';
import { Message } from '../components/Message.js';
import type {
  BabyDto, EventDto, ExportDto, InviteDto, MemberDto, MembersDto, StatsDto, SummaryDto, TaggedEventsDto,
  TypeSummaryDto,
} from '@dongfan/shared';
import { ApiFailure, OfflineError, apiRequest, apiRequestText, isOffline } from './api.js';
import * as local from './db.js';
import {
  getQueued, keepDraft, listDrafts, listQueued, listTags, putTags, reconcileDrafts, removeDraft,
  scopeOf,
} from './db.js';
import type { NewEventInput, QueuedCreate, StopDraft, StoredTag } from './db.js';
import { reconcileForms } from './form-draft.js';
import { runExclusive, runSerial } from './lane.js';
import {
  EntryGone, abandonQueued, attemptQueued, correctQueued, ensureMigrated, queueAdd, retryQueued,
  runOutbox,
} from './outbox.js';
import type { Attempt, Send } from './outbox.js';
import { syncEvents, syncSummary, syncTags } from './sync.js';
import { useSession } from './session.js';

/**
 * The screens' data.
 *
 * Read from the local database, filled by pulling changes from the server.
 * The screens never wait on the network to show something they already
 * have, which is what makes the app usable on a train and at three in the
 * morning in a room with no signal (spec 6.2).
 *
 * The summary is the exception and stays the server's: what changes when an
 * event moves is not something a client can work out, so it is fetched and
 * cached, and shown as old rather than as current when the fetch fails
 * (spec 5.5, 6.2).
 *
 * Adds go through the queue in `outbox.ts`, which means they are written
 * down before anything is sent and survive whatever happens next. Edits
 * and deletions do not: offline they are refused outright, because the
 * version they carry would be stale by the time they left and the answer
 * to the conflict that follows is a question for somebody who is asleep
 * (spec 6.1).
 */

/**
 * Re-exported from the storage layer, where it is defined.
 *
 * It is the shape of a queued add as much as the shape of a form, and the
 * two must not be allowed to drift apart.
 */
export type { NewEventInput };

export type EventPatch = {
  startedAt?: number;
  endedAt?: number | null;
  value?: number;
  note?: string;
  metadata?: Record<string, string>;
  /**
   * The whole list, not a change to it.
   *
   * Sent under the same version guard as the body, so a conflict leaves
   * the event and its tags both exactly as they were (spec 4.3, 6.3).
   */
  tagIds?: string[];
};

export type Store = {
  baby: BabyDto;
  /**
   * This account and this baby, as one string.
   *
   * Exposed so that anything keeping its own local state can be scoped the
   * same way everything else is. Switching either rebuilds this provider,
   * so a screen holding it cannot end up showing one family's data under
   * another's name (spec 6.2).
   */
  scope: string;
  /** Today's events in the baby timezone, all-day first then newest first. */
  events: EventDto[];
  summary: SummaryDto;
  now: number;
  loading: boolean;
  /** Set when the last refresh did not reach the server. */
  stale: boolean;
  /** True while a pull is in progress. */
  syncing: boolean;
  /** When the last successful pull finished, or null if there never was one. */
  syncedAt: number | null;
  /**
   * Adds that have not reached the server, oldest first.
   *
   * On screen as a count and as a list, never implied: storage here can be
   * cleared by the browser without warning, so "we are holding four of
   * your records" is something a parent has to be told (spec 6.1, 9.6).
   */
  unsynced: QueuedCreate[];
  /**
   * Timers stopped with no signal, waiting for somebody to confirm the
   * moment they were stopped at (spec 7.2).
   */
  stopDrafts: StopDraft[];
  /**
   * The baby's tags, as this device last heard them.
   *
   * On the device rather than fetched by the screen that needs them: a form
   * has to offer them with no signal, and a second place that fetched them
   * would be a second idea of what the list is.
   */
  tags: StoredTag[];
  /**
   * Makes one and returns it, or answers null when it cannot be done.
   *
   * Online only. The queue takes event creations and nothing else
   * (spec 6.1), and a tag minted on the device would need an id the server
   * does not know -- so the form offers what has been synced and says that
   * a new one needs a connection.
   */
  createTag: (name: string) => Promise<StoredTag | null>;
  /**
   * Renames a tag, then syncs.
   *
   * Throws what the server answered -- `TAG_NAME_TAKEN` above all -- so the
   * screen can say it. Online only, like every edit (spec 6.1).
   */
  renameTag: (tagId: string, name: string) => Promise<void>;
  /**
   * Deletes a tag, then syncs, so the records on this device lose it as the
   * server's have (spec 7.9).
   *
   * A tag that is already gone -- the other parent deleted it first -- is
   * thrown as the `NOT_FOUND` it is, after the sync has taken it off the
   * list, so the screen can say so rather than claiming a deletion it did
   * not make.
   */
  deleteTag: (tagId: string) => Promise<void>;
  /**
   * One page of the records carrying any of the given tags (spec 7.9).
   *
   * The server's, like the statistics: a page of a list the device may not
   * hold all of is not something to assemble here.
   */
  loadTagged: (query: TaggedQuery) => Promise<TaggedEventsDto>;
  /**
   * Everything the server holds for this baby, as the server wrote it
   * (spec 5.9). Thrown rather than returned when it cannot be had, or when
   * what came back is not the whole of what it says it is -- a short file is
   * the one result this must never hand over.
   */
  exportData: () => Promise<{ document: ExportDto; json: string }>;
  refresh: () => Promise<void>;
  /**
   * Sends one waiting add now, exactly as it stands, and resets its
   * counters.
   *
   * The content comes from the entry, not from a screen. That is the whole
   * point when the outcome is unknown: what has to go back is what went
   * before, and an entry can say what that was long after the form that
   * produced it has gone (spec 6.1).
   */
  retryUnsynced: (eventId: string) => Promise<EventDto | null>;
  /**
   * Replaces the content of a waiting add and sends it.
   *
   * Refused while its outcome is unknown; see `correctQueued`.
   */
  correctUnsynced: (eventId: string, input: NewEventInput) => Promise<EventDto | null>;
  /** Stops trying. Says nothing about whether the server has it. */
  abandonUnsynced: (eventId: string) => Promise<void>;
  /**
   * One event. Local when we have it, unless `fresh` is asked for.
   *
   * `fresh` exists for the reload after a version conflict: the local copy
   * is by definition the stale one, and handing it back would send the same
   * version again and collect the same 409 (spec 6.3).
   */
  findEvent: (eventId: string, options?: { fresh?: boolean }) => Promise<EventDto>;
  /**
   * Queues an add and, unless the device is plainly offline, tries to send
   * it there and then.
   *
   * The id is the caller's, not this function's. Generating one here would
   * mean a second press after a failure created a second event, which is
   * the one thing idempotency exists to prevent (spec 3.8, 6.1).
   *
   * Returns the stored event, or null when it is waiting in the queue.
   * A refusal from the server is thrown, because somebody is looking at
   * the screen and can do something about it.
   */
  addEvent: (eventId: string, input: NewEventInput) => Promise<EventDto | null>;
  updateEvent: (eventId: string, version: number, patch: EventPatch) => Promise<EventDto>;
  /**
   * Ends a running timer.
   *
   * Returns null when there was no connection: the moment is written down
   * instead, and has to be confirmed against the server's latest version
   * before it can be sent (spec 7.2).
   */
  stopTimer: (eventId: string, version: number, endedAt: number) => Promise<EventDto | null>;
  /**
   * Daily figures for a chart, aggregated by the server (spec 5.6).
   *
   * Never computed from the local events. A year is thousands of them, the
   * device holds only what it has synced, and a chart built here would be
   * short by whatever has not arrived -- while looking complete.
   */
  loadStats: (typeIds: readonly string[], from: string, to: string) => Promise<StatsDto>;
  /**
   * Throws away an unconfirmed stop, leaving the timer running.
   *
   * What it does not do is end the event: the server never heard about
   * this, so there is nothing there to undo.
   */
  discardStop: (eventId: string) => Promise<void>;
  removeEvent: (eventId: string, version: number) => Promise<void>;
  /**
   * The settings screen's four, which nothing else asks for.
   *
   * Fetched when that screen opens rather than held here: a list of two
   * people that changes once a year does not belong in the state every
   * other screen re-renders on (spec 7.8).
   */
  listMembers: () => Promise<MemberDto[]>;
  /** A one-time code, returned in full exactly once (spec 6.5). */
  createInvite: () => Promise<InviteDto>;
  removeMember: (userId: string) => Promise<void>;
  editBaby: (patch: { nickname?: string; gender?: string; birthDate?: string }) => Promise<void>;
};

/** The export arrived but is not what it claims to be. */
export class ExportIncomplete extends Error {
  constructor() {
    super('The export did not hold what it said it held');
    this.name = 'ExportIncomplete';
  }
}

export type TaggedQuery = {
  tagIds: readonly string[];
  from?: string | undefined;
  to?: string | undefined;
  sort: 'recent' | 'oldest';
  limit: number;
  offset: number;
};

const StoreContext = createContext<Store | null>(null);

/** All-day events sit above the timed ones; the server sorted the rest. */
function allDayFirst(events: EventDto[]): EventDto[] {
  const allDay = events.filter((e) => getEventType(e.typeId)?.allDay === true);
  return allDay.length === 0 ? events : [...allDay, ...events.filter((e) => !allDay.includes(e))];
}

export function StoreProvider({ baby, children }: { baby: BabyDto; children: ReactNode }): React.JSX.Element {
  const { token, expire, me, reload } = useSession();
  // One account, one baby. Everything below reads and writes under this,
  // so switching accounts cannot show the previous one's records and a
  // record cannot be filed against the wrong baby (spec 6.1, 6.2).
  const userId = me?.user.id ?? '';
  const scope = scopeOf(userId, baby.id);
  const [events, setEvents] = useState<EventDto[]>([]);
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [unsynced, setUnsynced] = useState<QueuedCreate[]>([]);
  const [stopDrafts, setStopDrafts] = useState<StopDraft[]>([]);
  const [tags, setTags] = useState<StoredTag[]>([]);
  // When the queue should wake up next. Null while there is nothing
  // waiting, and null while it is paused, which is what stops a timer
  // firing against a session that has already been rejected.
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Whether a drain is already waiting its turn. See `drain` below.
  const drainWaiting = useRef(false);
  const [now, setNow] = useState(() => Date.now());

  // One interval drives every elapsed display, rather than one per component.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The date comes from the baby's timezone, never the device's. Held as a
  // string so the hourly ticks above do not retrigger the fetch below.
  const today = toLocalDate(now, baby.timezone);

  /**
   * An expired session must sign the app out rather than surface as an
   * error on a screen the user can no longer load anything into.
   */
  const call = useCallback(
    async <T,>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> => {
      try {
        return await apiRequest<T>(path, { ...options, token: token ?? undefined });
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 401) expire();
        throw error;
      }
    },
    [token, expire],
  );

  /** Shows whatever is already here, without asking the network. */
  const readLocal = useCallback(async () => {
    // Before anything reads a form draft. Whether the content a screen was
    // part way through handing over ever reached the queue is not a
    // question `localStorage` can answer, and a screen that guessed would
    // either lose the typing or offer it back twice (spec 2.1, 3.8).
    await reconcileForms(scope);

    const [day, meta, queued, drafts, known] = await Promise.all([
      local.eventsOnDate(scope, today),
      local.readMeta(scope),
      listQueued(scope),
      reconcileDrafts(scope),
      listTags(scope),
    ]);
    setEvents(allDayFirst(day));
    setSyncedAt(meta.syncedAt);
    setUnsynced(queued);
    setStopDrafts(drafts);
    setTags(known);
    if (meta.summary) setSummary(meta.summary);
    return meta;
  }, [scope, today]);

  /**
   * Local first, then the network.
   *
   * The order is the point: a screen that has yesterday's data shows it
   * immediately and corrects itself, rather than showing a spinner over
   * records that are sitting on the device.
   */
  const refresh = useCallback(async () => {
    await readLocal();

    const { cursor } = await syncEvents(scope, baby.id, call);
    // Tagged with the cursor it was fetched at, which is the only thing
    // that orders two summaries.
    await syncSummary(scope, baby.id, call, cursor);
    // The other half of spec 7.9: the events learn through their revs that
    // their tags changed, and this is how the device learns what the tags
    // now are -- including that one of them is gone.
    await syncTags(scope, baby.id, call);

    // Everything on screen comes back out of the database rather than from
    // the replies that were just received. A reply can be refused for being
    // older than what is stored, and showing it anyway would leave the
    // screen and the device disagreeing until the next reload.
    const meta = await local.readMeta(scope);
    setEvents(allDayFirst(await local.eventsOnDate(scope, today)));
    setUnsynced(await listQueued(scope));
    setStopDrafts(await reconcileDrafts(scope));
    setTags(await listTags(scope));
    if (meta.summary) setSummary(meta.summary);
    setSyncedAt(meta.syncedAt);
  }, [call, readLocal, scope, baby.id, today]);

  // Kept in a ref so a trigger can refresh without depending on a callback
  // that changes identity every time the date string does.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Through the same lane as every other trigger. Calling refresh
    // directly here was the one entrance that bypassed it, so a first sync
    // slow enough to still be running when the app came to the front, or
    // when something was written, overlapped with the sync that caused --
    // which is exactly the situation the lane exists for.
    runExclusive(scope, async () => {
      setSyncing(true);
      try {
        await refreshRef.current();
        if (!cancelled) setStale(false);
      } catch {
        if (cancelled) return;
        // The network is gone, which is not the same as having nothing to
        // show. Whatever was pulled before is still here.
        setStale(true);
        await readLocal().catch(() => undefined);
      } finally {
        setSyncing(false);
        if (!cancelled) setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refresh, readLocal, scope, attempt]);

  /**
   * Refetches after a write, and whenever something says to.
   *
   * Everything for this baby, not a computed subset: the cost of refetching
   * two small responses is far below the cost of getting the subset wrong.
   */
  const settle = useCallback(async (): Promise<void> => {
    // One at a time for this baby. Four things ask for a sync and none of
    // them knew about the others, so the one that answered last won -- and
    // that is not the one that asked last. A request arriving during a run
    // is queued rather than dropped, because a record written during a slow
    // pull needs the refresh it asked for.
    await runExclusive(scope, async () => {
      setSyncing(true);
      try {
        await refreshRef.current();
        setStale(false);
      } catch {
        setStale(true);
      } finally {
        setSyncing(false);
      }
    });
  }, [scope]);

  /**
   * The one way an add leaves this device.
   *
   * Handed to the queue rather than called by it, so that nothing in
   * `outbox.ts` knows about tokens, paths or the session -- and so the
   * queue's rules can be tested without a network at all.
   */
  const send = useCallback<Send>(
    (eventId, input) =>
      call<EventDto>(`/babies/${baby.id}/events`, {
        method: 'POST',
        body: { id: eventId, ...input },
      }),
    [call, baby.id],
  );

  /**
   * Sends whatever the queue says is due.
   *
   * In its own lane, not the sync one: a queue working through ten entries
   * must not hold up the pull that shows what the other parent just
   * recorded, and neither may overlap with itself.
   *
   * The migration runs first, every time, because it is cheap when there
   * is nothing to move and because the first drain after an upgrade is
   * exactly when the entries it rescues matter most.
   */
  const drain = useCallback(async (): Promise<void> => {
    let sent = 0;

    // At most one waiting behind whatever is running. Four things ask for
    // a drain and a second queued one would find nothing left to do, but
    // this cannot be done by collapsing tasks in the queue itself: a send
    // that was collapsed into somebody else's would never happen, and its
    // caller would be told it had.
    if (drainWaiting.current) return;
    drainWaiting.current = true;

    await runSerial(`outbox:${scope}`, async () => {
      drainWaiting.current = false;
      await ensureMigrated();

      // Nothing is attempted while the device says it has no connection.
      // An attempt that cannot leave still fails, and a failure that
      // cannot leave would spend one of the ten and mark the entry as
      // possibly stored -- barring a parent from correcting a record that
      // certainly never went anywhere (spec 6.1). Coming back online is
      // one of the things that calls this, so nothing is left waiting on a
      // timer that was deliberately not armed.
      if (isOffline()) {
        setUnsynced(await listQueued(scope));
        setDueAt(null);
        return;
      }

      const result = await runOutbox(scope, send);
      sent = result.sent;
      setUnsynced(await listQueued(scope));
      // A paused queue arms no timer. It waits for the same person to sign
      // in again, which remounts everything below and starts it off
      // (spec 6.1).
      setDueAt(result.paused ? null : result.nextDueAt);
    });

    // Outside the queue's lane and through the sync one, or a drain and a
    // pull could run against each other.
    if (sent > 0) await settle();
  }, [scope, send, settle]);

  /**
   * Wakes the queue when the next entry falls due.
   *
   * One timer for the earliest of them rather than one each, and none at
   * all when nothing is waiting: a phone in a pocket should not be woken
   * to find out there is nothing to do.
   */
  useEffect(() => {
    if (dueAt === null) return;

    // A floor, so that an entry which somehow reports itself due on every
    // pass cannot turn this into a spin.
    const delay = Math.max(1_000, dueAt - Date.now());
    const timer = setTimeout(() => void drain(), delay);
    return () => clearTimeout(timer);
  }, [dueAt, drain]);

  /** First pass, once the app has an account and a baby. */
  useEffect(() => {
    void drain();
  }, [drain]);

  /**
   * Pulls again when the app comes back.
   *
   * Without this the only thing that syncs is this device's own writing.
   * The other parent records a feed, this phone is picked up an hour later,
   * and it shows the same screen it had -- with nothing to say it is out of
   * date, because as far as it knows nothing has happened (spec 6.1).
   *
   * `online` covers coming out of a tunnel; `visibilitychange` covers the
   * far more common case of a phone that was simply in a pocket.
   */
  useEffect(() => {
    const again = (): void => {
      if (document.visibilityState === 'hidden') return;
      void settle();
      // The same two moments the queue has been waiting for. A phone that
      // was in a pocket through a tunnel has both a pull and a send to do.
      void drain();
    };

    window.addEventListener('online', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('online', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [settle, drain]);

  /**
   * Tries to send one entry that is already in the queue.
   *
   * Every add goes through here, whether it is new, being resent or being
   * corrected, and in all three cases the entry is in storage before the
   * request leaves. A refusal is thrown because somebody is looking at the
   * screen; the entry stays queued either way, so nothing at all depends
   * on what they do about it.
   */
  const push = useCallback(
    async (entry: QueuedCreate | null): Promise<EventDto | null> => {
      setUnsynced(await listQueued(scope));
      if (!entry) return null;

      // Nothing can have been sent, so nothing is in doubt. This is the
      // three-in-the-morning case the queue exists for, and it is also
      // what lets the entry still be corrected later (spec 6.1).
      if (isOffline()) {
        setDueAt(Date.now());
        return null;
      }

      // Held in an object rather than a plain variable so that what the
      // lane assigns is visible to the code after it.
      const outcome: { attempt: Attempt | null } = { attempt: null };

      // Through the same lane as the background run. Coming back online, a
      // timer falling due and somebody pressing retry are three entrances
      // to one queue; without this they can have the same entry in the air
      // twice, with the two answers racing to write its state.
      await runSerial(`outbox:${scope}`, async () => {
        // Read again now the queue is ours. Whatever ran in front may have
        // sent this entry, corrected it or been given up on.
        const current = await getQueued(scope, entry.eventId);
        if (!current) return;

        outcome.attempt = await attemptQueued(scope, current, send);
        setUnsynced(await listQueued(scope));
      });

      if (outcome.attempt === null) {
        // Not in the queue any more. If it is in the local database then
        // the run in front of this one sent it, which is what was being
        // asked for -- so this is a success, not a failure.
        const already = await local.findEvent(scope, entry.eventId);
        if (already) return already;
        // Neither queued nor stored: abandoned while this was waiting.
        throw new EntryGone(entry.eventId);
      }

      if (!outcome.attempt.ok) {
        const failed = outcome.attempt.entry;
        setDueAt(failed.state === 'queued' ? failed.nextAttemptAt : null);
        throw outcome.attempt.error;
      }

      await settle();
      // Reaching the server says the connection is up, which is the best
      // moment there is to clear whatever else is waiting.
      void drain();
      return outcome.attempt.event;
    },
    [scope, send, settle, drain],
  );

  const addEvent = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto | null> => {
      // Written down before anything is sent, every time. The window
      // between pressing save and a request failing is where a record used
      // to be lost: a 401 takes the screen holding it away immediately,
      // and a browser killed in that moment took the event id with it.
      return push(await queueAdd(userId, baby.id, eventId, input));
    },
    [userId, baby.id, push],
  );

  const updateEvent = useCallback(
    async (eventId: string, version: number, patch: EventPatch): Promise<EventDto> => {
      // Refused rather than queued. An edit made offline carries the
      // version that was read offline, so it comes back 409 nearly every
      // time, and a 409 is answered by asking somebody who is asleep
      // (spec 6.1). Stopping a timer offline is the one case that genuinely
      // loses data this way, and it gets a draft of its own in the next
      // stage (spec 7.2) rather than a general offline edit queue.
      if (isOffline()) throw new OfflineError();

      const updated = await call<EventDto>(`/events/${eventId}`, {
        method: 'PATCH',
        body: { version, ...patch },
      });
      await local.applyOne(scope, updated);
      // Deliberately not touching the stop draft. "Any successful update
      // answers it" looked safe and is not: correcting a note on an event
      // whose timer is still running would throw away the moment somebody
      // pressed stop at, and the timer would go on running with nothing
      // left to say when it should have ended.
      await settle();
      return updated;
    },
    [call, scope, settle],
  );

  /**
   * Ends a running timer, or writes down when it was ended.
   *
   * The one edit that may not simply be refused offline. Somebody presses
   * stop at 03:10 and the signal comes back at 03:40; telling them to
   * remember and fill it in later means the sleep is recorded half an hour
   * too long, and sleep length is the thing this app exists to get right
   * (spec 7.2).
   *
   * The draft is not sent when the connection returns. The other parent
   * may have stopped or edited the same timer in between, and what to do
   * about that is a question for a person, not a rule (spec 6.3).
   */
  const stopTimer = useCallback(
    async (eventId: string, version: number, endedAt: number): Promise<EventDto | null> => {
      // Written down before anything is attempted, whatever the device
      // thinks of its connection. `navigator.onLine` says an interface is
      // up, not that the server can be reached: a worker that has stopped,
      // a tunnel, a captive portal and a lost response all look like a
      // healthy phone from here, and every one of them used to lose the
      // moment the button was pressed at.
      const kept = await keepDraft({ scope, eventId, endedAt, version, createdAt: Date.now() });
      setStopDrafts(await listDrafts(scope));

      if (isOffline()) return null;

      // The stored moment, not the one just handed in.
      //
      // The two are the same today, because after the first press the card
      // stops being a button and there is no second press to make. This is
      // written as "send what is stored" rather than "send what you were
      // given" because the stored one is the answer either way: it is what
      // `keepDraft` refuses to move, and what the confirmation screen will
      // offer if this attempt fails.
      let updated: EventDto;
      try {
        updated = await updateEvent(eventId, version, { endedAt: kept.endedAt });
      } catch (error) {
        // A failed stop leaves the same doubt a failed add does: it may
        // have been applied and lost its answer on the way back. Pulling
        // settles that on its own -- an event that comes back already
        // ending at this exact instant was this press -- and if the pull
        // fails too, nothing is lost and the usual triggers try again.
        //
        // What does not happen is the update being sent a second time.
        // The other parent may have touched the timer meanwhile, and that
        // is a question for a person (spec 7.2, 6.3).
        void settle();
        throw error;
      }

      // Only a definite success clears it here. Everything else leaves the
      // moment to be confirmed against whatever the server turns out to
      // hold.
      await removeDraft(scope, eventId);
      setStopDrafts(await listDrafts(scope));
      return updated;
    },
    [scope, updateEvent, settle],
  );

  const discardStop = useCallback(
    async (eventId: string): Promise<void> => {
      await removeDraft(scope, eventId);
      setStopDrafts(await listDrafts(scope));
    },
    [scope],
  );

  const removeEvent = useCallback(
    async (eventId: string, version: number): Promise<void> => {
      // Same rule as editing, and for the same reason.
      if (isOffline()) throw new OfflineError();

      // The tombstone comes back, and storing it is what hides the event
      // even if the sync afterwards fails.
      const tombstone = await call<EventDto>(`/events/${eventId}`, {
        method: 'DELETE',
        body: { version },
      });
      await local.applyOne(scope, tombstone);
      await settle();
    },
    [call, scope, settle],
  );

  /**
   * One event, from here if we have it.
   *
   * Falling back to the network covers the event that has not been pulled
   * yet -- a link opened before the first sync finished, for instance. What
   * comes back is stored, so the next read does not have to ask again.
   */
  const findEvent = useCallback(
    async (eventId: string, options: { fresh?: boolean } = {}): Promise<EventDto> => {
      if (!options.fresh) {
        const held = await local.findEvent(scope, eventId);
        if (held) return held;
      }

      const fetched = await call<EventDto>(`/events/${eventId}`);
      await local.applyOne(scope, fetched);
      return fetched;
    },
    [call, scope],
  );

  /**
   * The three things a parent can do with a record that has not been sent.
   *
   * Each one writes to the queue first and then asks it to run, so what
   * happens next does not depend on the screen still being there.
   */
  const retryUnsynced = useCallback(
    async (eventId: string): Promise<EventDto | null> => push(await retryQueued(scope, eventId)),
    [scope, push],
  );

  const correctUnsynced = useCallback(
    async (eventId: string, input: NewEventInput): Promise<EventDto | null> =>
      push(await correctQueued(scope, eventId, input)),
    [scope, push],
  );

  const abandonUnsynced = useCallback(
    async (eventId: string): Promise<void> => {
      await abandonQueued(scope, eventId);
      setUnsynced(await listQueued(scope));
    },
    [scope],
  );

  const listMembers = useCallback(
    async (): Promise<MemberDto[]> =>
      (await call<MembersDto>(`/babies/${baby.id}/members`)).members,
    [call, baby.id],
  );

  const createInvite = useCallback(
    (): Promise<InviteDto> => call<InviteDto>(`/babies/${baby.id}/invite`, { method: 'POST' }),
    [call, baby.id],
  );

  const removeMember = useCallback(
    async (userId: string): Promise<void> => {
      await call(`/babies/${baby.id}/members/${userId}`, { method: 'DELETE' });
      // Which babies this account can see is decided by the account, so
      // removing somebody -- including oneself -- is only visible once it
      // has been read again.
      await reload();
    },
    [call, baby.id, reload],
  );

  const editBaby = useCallback(
    async (patch: { nickname?: string; gender?: string; birthDate?: string }): Promise<void> => {
      await call<BabyDto>(`/babies/${baby.id}`, { method: 'PATCH', body: patch });
      // The baby on screen comes from the account description, not from
      // here, so nothing changes until that is read again.
      await reload();
    },
    [call, baby.id, reload],
  );

  /**
   * Daily figures for a chart, straight from the server (spec 5.6).
   *
   * Not computed here, and deliberately so. The aggregation is the
   * database's: a year is thousands of events, and the device holds only
   * what it has synced, so a chart built locally would be quietly short by
   * whatever has not arrived -- and would disagree with the same chart on
   * the other parent's phone.
   *
   * Nothing is cached. A chart is looked at rarely and read once; keeping
   * it in IndexedDB would mean deciding when it goes stale, which is a
   * question the events themselves already answer.
   */
  const loadStats = useCallback(
    (typeIds: readonly string[], from: string, to: string): Promise<StatsDto> =>
      call<StatsDto>(
        `/babies/${baby.id}/stats?types=${typeIds.join(',')}&from=${from}&to=${to}`,
      ),
    [call, baby.id],
  );

  /**
   * Adds a tag and keeps it, so the form it was typed in can select it at
   * once rather than waiting for the next sync.
   *
   * A repeated name comes back as the tag that already exists -- two
   * parents adding "night" on the same evening is ordinary (spec 3.7) --
   * so this is also how a race resolves itself.
   */
  const createTag = useCallback(async (name: string): Promise<StoredTag | null> => {
    try {
      const made = await call<{ id: string; name: string; createdAt: number }>(
        `/babies/${baby.id}/tags`,
        { method: 'POST', body: { name } },
      );
      const held = (await listTags(scope))
        .filter((one) => one.id !== made.id)
        .map((one) => ({ id: one.id, name: one.name, createdAt: one.createdAt }));
      await putTags(scope, [...held, made]);

      const stored = await listTags(scope);
      setTags(stored);
      return stored.find((one) => one.id === made.id) ?? null;
    } catch {
      // Offline, or refused. The form says a new tag needs a connection
      // rather than pretending one was made.
      return null;
    }
  }, [call, baby.id, scope]);

  /** The synced list with one tag changed, kept until the sync replaces it. */
  const keepTags = useCallback(async (change: (held: StoredTag[]) => StoredTag[]): Promise<void> => {
    const held = change(await listTags(scope))
      .map((one) => ({ id: one.id, name: one.name, createdAt: one.createdAt }));
    await putTags(scope, held);
    setTags(await listTags(scope));
  }, [scope]);

  const renameTag = useCallback(async (tagId: string, name: string): Promise<void> => {
    if (isOffline()) throw new OfflineError();
    const renamed = await call<{ id: string; name: string; createdAt: number }>(
      `/babies/${baby.id}/tags/${tagId}`,
      { method: 'PATCH', body: { name } },
    );
    // Shown at once rather than after the sync, which can be slow and can
    // fail; the sync then brings the moved events and the whole list.
    await keepTags((held) => held.map((one) => (one.id === renamed.id ? { ...one, name: renamed.name } : one)));
    await settle();
  }, [call, baby.id, keepTags, settle]);

  const deleteTag = useCallback(async (tagId: string): Promise<void> => {
    if (isOffline()) throw new OfflineError();
    try {
      await call(`/babies/${baby.id}/tags/${tagId}`, { method: 'DELETE' });
    } catch (error) {
      // Gone already. The sync is what makes this device agree, and the
      // error still goes up: "deleted" would be a claim about this press.
      if (error instanceof ApiFailure && error.code === 'NOT_FOUND') await settle();
      throw error;
    }
    await keepTags((held) => held.filter((one) => one.id !== tagId));
    // The records lose the tag through their revs, which only a sync
    // brings. Without it this device would go on showing a deleted tag's
    // id on every record that had it (spec 7.9).
    await settle();
  }, [call, baby.id, keepTags, settle]);

  const loadTagged = useCallback(
    (query: TaggedQuery): Promise<TaggedEventsDto> => {
      const params = new URLSearchParams({
        tags: query.tagIds.join(','),
        sort: query.sort,
        limit: String(query.limit),
        offset: String(query.offset),
      });
      if (query.from !== undefined) params.set('from', query.from);
      if (query.to !== undefined) params.set('to', query.to);
      return call<TaggedEventsDto>(`/babies/${baby.id}/events?${params.toString()}`);
    },
    [call, baby.id],
  );

  const exportData = useCallback(async (): Promise<{ document: ExportDto; json: string }> => {
    if (isOffline()) throw new OfflineError();
    let json: string;
    try {
      json = await apiRequestText(`/babies/${baby.id}/export`, { token: token ?? undefined });
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) expire();
      throw error;
    }

    let document: ExportDto;
    try {
      document = JSON.parse(json) as ExportDto;
    } catch {
      throw new ExportIncomplete();
    }
    // The server checks this too. Checked again here because this is the
    // last point before a file exists, and whatever happened in between --
    // a proxy, a cut connection that still parsed -- happened after it.
    if (
      document.format !== 'dongfan-export'
      || !Array.isArray(document.events)
      || document.events.length !== document.eventCount
    ) {
      throw new ExportIncomplete();
    }
    return { document, json };
  }, [baby.id, token, expire]);

  const value = useMemo<Store>(
    () => ({
      baby, scope, events, summary: summary as SummaryDto, now, loading, stale, syncing, syncedAt,
      unsynced, stopDrafts, tags, createTag, renameTag, deleteTag, loadTagged, exportData,
      refresh: settle, findEvent, addEvent, updateEvent, stopTimer,
      loadStats,
      discardStop, removeEvent, retryUnsynced, correctUnsynced, abandonUnsynced,
      listMembers, createInvite, removeMember, editBaby,
    }),
    [baby, scope, events, summary, now, loading, stale, syncing, syncedAt, unsynced, stopDrafts,
      tags, createTag, renameTag, deleteTag, loadTagged, exportData, settle,
      loadStats,
      findEvent, addEvent, updateEvent, stopTimer, discardStop, removeEvent, retryUnsynced,
      correctUnsynced, abandonUnsynced, listMembers, createInvite, removeMember, editBaby],
  );

  // Nothing below this point has to cope with an absent summary. Gating here
  // rather than threading a null through every screen keeps "we have not
  // loaded yet" from looking like "there is nothing recorded". A cached one
  // from a previous run counts, which is what lets the app open offline.
  if (summary === null) {
    return loading
      ? <Message text={zhTW.app.loading} />
      : <Message text={zhTW.home.syncFailed} onRetry={() => setAttempt((n) => n + 1)} />;
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore used outside StoreProvider');
  return store;
}

/** The unconfirmed stop for one event, if there is one. */
export function draftFor(drafts: readonly StopDraft[], eventId: string | null): StopDraft | null {
  if (eventId === null) return null;
  return drafts.find((draft) => draft.eventId === eventId) ?? null;
}

/** The summary entry for one type, or null when nothing is recorded yet. */
export function typeSummary(summary: SummaryDto, typeId: string): TypeSummaryDto | null {
  return summary.types.find((entry) => entry.typeId === typeId) ?? null;
}
