import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Check, Pencil } from 'lucide-react';
import { TAG_FILTER_DEFAULT_LIMIT, TAG_FILTER_MAX_LIMIT, interpolate, isRealLocalDate, toLocalDate, zhTW } from '@dongfan/shared';
import type { EventDto } from '@dongfan/shared';
import { EmptyDay, EventRow } from '../components/EventRow.js';
import { ErrorLine, describeFailure } from '../components/FieldErrors.js';
import { PageMenu } from '../components/PageMenu.js';
import { SyncState } from '../components/SyncState.js';
import { ApiFailure } from '../lib/api.js';
import type { StoredTag } from '../lib/db.js';
import { useStore } from '../lib/store.js';

/**
 * The tag page (spec 7.9): the baby's tags, managing them, and the records
 * carrying any of the chosen ones.
 *
 * **What is chosen lives in the URL**, not in state. Opening a record from
 * the results and coming back remounts this screen; held in state, the
 * choice -- and the reason somebody opened the page -- would be gone.
 *
 * **The results are the server's.** A tag can be on a year of records and
 * the page is paged, so like the statistics this needs a connection and
 * says so rather than showing an empty list, which would be a claim
 * (spec 7.9, 7.11). The tag list itself is the device's, synced with the
 * events, so it opens with no signal.
 *
 * **An answer that arrives late acts on the page as it is now, or not at
 * all.** Every request carries the query it was made for, and a reply to a
 * query that is no longer the one on screen is dropped -- the same rule the
 * forms learned in stage 3, here for a list that can be re-asked while a
 * "more" is still in the air.
 */

type Sort = 'recent' | 'oldest';

/** One query, as a key: two requests answer the same question when these match. */
function keyOf(tagIds: readonly string[], sort: Sort, from: string, to: string): string {
  return [[...tagIds].sort().join(','), sort, from, to].join('|');
}

type Results = {
  key: string;
  events: EventDto[];
  /** Rows the server has handed over, duplicates included; the next offset. */
  consumed: number;
  total: number;
  hasMore: boolean;
};

export function Tags(): React.JSX.Element {
  const {
    baby, now, tags, unsynced, syncedAt, stopDrafts, createTag, renameTag, deleteTag, loadTagged,
  } = useStore();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const here = `${location.pathname}${location.search}`;

  const asked = useMemo(() => (search.get('t') ?? '').split(',').filter((id) => id !== ''), [search]);
  const sort: Sort = search.get('sort') === 'oldest' ? 'oldest' : 'recent';
  const from = isRealLocalDate(search.get('from') ?? '') ? (search.get('from') ?? '') : '';
  const to = isRealLocalDate(search.get('to') ?? '') ? (search.get('to') ?? '') : '';

  /**
   * Only tags this device knows about. A tag deleted -- here, or by the
   * other parent and learnt through a sync -- leaves the choice by this
   * alone; otherwise it would be asked about for ever and shown as chosen
   * with nothing on screen to un-choose.
   */
  const chosen = useMemo(
    () => asked.filter((id) => tags.some((tag) => tag.id === id)),
    [asked, tags],
  );

  const update = useCallback((change: (next: URLSearchParams) => void): void => {
    setSearch((current) => {
      const next = new URLSearchParams(current);
      change(next);
      return next;
    }, { replace: true });
  }, [setSearch]);

  const setChosen = (ids: readonly string[]): void => {
    update((next) => {
      if (ids.length === 0) next.delete('t');
      else next.set('t', ids.join(','));
    });
  };

  const toggle = (id: string): void => {
    setChosen(chosen.includes(id) ? chosen.filter((one) => one !== id) : [...chosen, id]);
  };

  const setParam = (name: string, value: string): void => {
    update((next) => {
      if (value === '') next.delete(name);
      else next.set(name, value);
    });
  };

  // ------------------------------------------------------------ the results

  const key = keyOf(chosen, sort, from, to);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  /** Bumped to ask again after a failure, since nothing else has changed. */
  const [attempt, setAttempt] = useState(0);
  /** The query on screen now, for answers that come back after it moved. */
  const current = useRef(key);
  current.current = key;
  /** How many rows are showing, so a re-ask after a sync keeps the list as long. */
  const shown = useRef(0);
  shown.current = results?.key === key ? results.consumed : 0;

  const query = useCallback(
    (offset: number, limit: number) => loadTagged({
      tagIds: chosen,
      sort,
      from: from === '' ? undefined : from,
      to: to === '' ? undefined : to,
      offset,
      limit,
    }),
    [loadTagged, chosen, sort, from, to],
  );

  useEffect(() => {
    if (chosen.length === 0) {
      setResults(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    const asking = key;
    setLoading(true);
    setFailure(null);
    // As long as what is showing, when this is a re-ask for the same
    // question after a sync: starting again from fifty would take away the
    // part of the list somebody had scrolled to.
    const limit = Math.min(TAG_FILTER_MAX_LIMIT, Math.max(TAG_FILTER_DEFAULT_LIMIT, shown.current));
    query(0, limit)
      .then((page) => {
        if (current.current !== asking) return;
        setResults({
          key: asking,
          events: page.events,
          consumed: page.events.length,
          total: page.total,
          hasMore: page.hasMore,
        });
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (current.current !== asking) return;
        setFailure(error);
        setLoading(false);
      });
    // `syncedAt` is not read in here. It is the signal that the app has
    // caught up -- a record edited, a tag taken off one -- and the list is
    // the server's, so it is asked again (spec 6.1).
  }, [key, chosen.length, query, syncedAt, attempt]);

  const [more, setMore] = useState(false);
  const loadMore = async (): Promise<void> => {
    if (!results || results.key !== key || more) return;
    const asking = key;
    setMore(true);
    setFailure(null);
    try {
      const page = await query(results.consumed, TAG_FILTER_DEFAULT_LIMIT);
      if (current.current !== asking) return;
      setResults((before) => {
        if (!before || before.key !== asking) return before;
        // Offsets are positions in a list other people can change between
        // two pages. A record added at the top pushes the one at the
        // boundary onto this page as well, and showing it twice would be
        // two records where there is one. Kept once, by id.
        const seen = new Set(before.events.map((event) => event.id));
        return {
          key: asking,
          events: [...before.events, ...page.events.filter((event) => !seen.has(event.id))],
          consumed: before.consumed + page.events.length,
          total: page.total,
          hasMore: page.hasMore,
        };
      });
    } catch (error) {
      if (current.current === asking) setFailure(error);
    } finally {
      setMore(false);
    }
  };

  const showing = results !== null && results.key === key ? results : null;
  const today = toLocalDate(now, baby.timezone);

  /**
   * Records on this phone the server has not seen, carrying a chosen tag.
   * The results are the server's, so these are missing from them -- and
   * saying so is the difference between a list that is behind and one that
   * is wrong (spec 6.2).
   */
  const waiting = unsynced.filter((entry) => (entry.input.tagIds ?? []).some((id) => chosen.includes(id))).length;

  // ------------------------------------------------------- managing a tag

  const [adding, setAdding] = useState('');
  const [addFailed, setAddFailed] = useState(false);
  const [addBusy, setAddBusy] = useState(false);

  const add = async (): Promise<void> => {
    const wanted = adding.trim();
    if (wanted === '' || addBusy) return;
    setAddBusy(true);
    setAddFailed(false);
    const made = await createTag(wanted);
    setAddBusy(false);
    if (!made) {
      setAddFailed(true);
      return;
    }
    setAdding('');
  };

  const [managing, setManaging] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [manageFailure, setManageFailure] = useState<unknown>(null);
  const [manageBusy, setManageBusy] = useState(false);

  const open = (tag: StoredTag): void => {
    setManaging(managing === tag.id ? null : tag.id);
    setName(tag.name);
    setManageFailure(null);
  };

  const rename = async (tag: StoredTag): Promise<void> => {
    const wanted = name.trim();
    if (wanted === '' || manageBusy) return;
    setManageBusy(true);
    setManageFailure(null);
    try {
      await renameTag(tag.id, wanted);
      setManaging(null);
    } catch (error) {
      setManageFailure(error);
    } finally {
      setManageBusy(false);
    }
  };

  const [confirming, setConfirming] = useState<StoredTag | null>(null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col px-2 pt-2.5 pb-1.5">
        <div className="flex items-center gap-1">
          <PageMenu />
          <span className="flex-1 text-center text-base font-medium">{zhTW.tagPage.title}</span>
          <span className="size-11" />
        </div>
        <div className="flex justify-center">
          <SyncState now={now} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-8">
        {tags.length === 0 ? (
          <EmptyDay title={zhTW.tagPage.empty} />
        ) : (
          <>
            <p className="mb-2 text-[13px] text-ink-muted">{zhTW.tagPage.pick}</p>
            <ul className="mb-3 flex flex-col gap-1.5" data-testid="tag-list">
              {tags.map((tag) => {
                const on = chosen.includes(tag.id);
                return (
                  <li key={tag.id} className="rounded-xl border border-line bg-surface" data-testid="tag-row" data-tag-id={tag.id}>
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => toggle(tag.id)}
                        aria-pressed={on}
                        data-testid="tag-choose"
                        className="flex min-h-12 flex-1 items-center gap-2 px-3.5 text-left text-[15px]"
                      >
                        <span
                          className={`flex size-5 shrink-0 items-center justify-center rounded border ${
                            on ? 'border-accent bg-accent text-ground' : 'border-line'
                          }`}
                          aria-hidden
                        >
                          {on ? <Check size={14} /> : null}
                        </span>
                        <span className="min-w-0 truncate">{tag.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => open(tag)}
                        aria-label={interpolate(zhTW.tagPage.manage, { name: tag.name })}
                        aria-expanded={managing === tag.id}
                        data-testid="tag-manage"
                        className="flex size-12 shrink-0 items-center justify-center text-ink-faint"
                      >
                        <Pencil size={16} />
                      </button>
                    </div>

                    {managing === tag.id ? (
                      <div className="border-t border-line-soft px-3.5 py-3" data-testid="tag-editor">
                        <div className="flex items-center gap-2">
                          <input
                            value={name}
                            maxLength={30}
                            disabled={manageBusy}
                            aria-label={zhTW.addEvent.tagName}
                            data-testid="tag-rename-input"
                            onChange={(e) => { setName(e.target.value); setManageFailure(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); void rename(tag); }
                            }}
                            className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-ground px-3 text-[15px] outline-none"
                          />
                          <button
                            type="button"
                            disabled={manageBusy || name.trim() === '' || name.trim() === tag.name}
                            onClick={() => void rename(tag)}
                            data-testid="tag-rename-save"
                            className="min-h-11 rounded-xl border border-line px-3 text-[13px] text-accent disabled:opacity-50"
                          >
                            {zhTW.tagPage.save}
                          </button>
                        </div>
                        {manageFailure !== null ? (
                          <p className="mt-2 text-[12px] text-red-300" data-testid="tag-manage-error">
                            {describeFailure(manageFailure)}
                          </p>
                        ) : null}
                        <div className="mt-2 flex justify-between">
                          <button
                            type="button"
                            onClick={() => setManaging(null)}
                            className="min-h-11 px-1 text-[13px] text-ink-dim"
                          >
                            {zhTW.tagPage.cancel}
                          </button>
                          <button
                            type="button"
                            disabled={manageBusy}
                            onClick={() => setConfirming(tag)}
                            data-testid="tag-delete"
                            className="min-h-11 px-2 text-[13px] text-red-300 disabled:opacity-50"
                          >
                            {zhTW.tagPage.delete}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="mb-5 flex items-center gap-2">
          <input
            value={adding}
            maxLength={30}
            disabled={addBusy}
            placeholder={zhTW.tagPage.add}
            aria-label={zhTW.tagPage.add}
            data-testid="tag-add-input"
            onChange={(e) => { setAdding(e.target.value); setAddFailed(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void add(); }
            }}
            className="min-h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 text-[15px] outline-none"
          />
          <button
            type="button"
            disabled={addBusy || adding.trim() === ''}
            onClick={() => void add()}
            data-testid="tag-add"
            className="min-h-11 rounded-xl border border-line px-3 text-[13px] text-accent disabled:opacity-50"
          >
            {zhTW.tagPage.addButton}
          </button>
        </div>
        {addFailed ? (
          <p className="-mt-3 mb-4 text-[12px] text-warn-soft" data-testid="tag-add-offline">
            {zhTW.addEvent.tagNeedsConnection}
          </p>
        ) : null}

        {chosen.length > 0 ? (
          <section data-testid="tag-results">
            <p className="mb-2 text-[12px] text-ink-dim">{zhTW.tagPage.anyOf}</p>

            <div className="mb-2 flex gap-1.5" role="group" aria-label={zhTW.tagPage.sort}>
              {(['recent', 'oldest'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={sort === option}
                  onClick={() => setParam('sort', option === 'recent' ? '' : option)}
                  data-testid={`tag-sort-${option}`}
                  className={`min-h-11 flex-1 rounded-xl border text-[13px] ${
                    sort === option ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-muted'
                  }`}
                >
                  {option === 'recent' ? zhTW.tagPage.recent : zhTW.tagPage.oldest}
                </button>
              ))}
            </div>

            <div className="mb-3 flex items-end gap-2">
              <label className="min-w-0 flex-1 text-[12px] text-ink-muted">
                {zhTW.tagPage.from}
                <input
                  type="date"
                  value={from}
                  max={to === '' ? undefined : to}
                  onChange={(e) => setParam('from', e.target.value)}
                  data-testid="tag-from"
                  className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-2 text-[14px] text-ink"
                />
              </label>
              <label className="min-w-0 flex-1 text-[12px] text-ink-muted">
                {zhTW.tagPage.to}
                <input
                  type="date"
                  value={to}
                  min={from === '' ? undefined : from}
                  onChange={(e) => setParam('to', e.target.value)}
                  data-testid="tag-to"
                  className="mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-2 text-[14px] text-ink"
                />
              </label>
              {from !== '' || to !== '' ? (
                <button
                  type="button"
                  onClick={() => update((next) => { next.delete('from'); next.delete('to'); })}
                  data-testid="tag-clear-range"
                  className="min-h-11 shrink-0 px-1 text-[12px] text-ink-dim"
                >
                  {zhTW.tagPage.clearRange}
                </button>
              ) : null}
            </div>

            {waiting > 0 ? (
              <p className="mb-2 text-[12px] text-warn-soft" data-testid="tag-unsynced">
                {interpolate(zhTW.tagPage.unsynced, { count: waiting })}
              </p>
            ) : null}

            {showing === null ? (
              failure !== null && !loading ? (
                <Failed failure={failure} onRetry={() => setAttempt((n) => n + 1)} />
              ) : (
                <p className="py-6 text-center text-sm text-ink-dim" data-testid="tag-loading">…</p>
              )
            ) : (
              <>
                <p className="mb-1 text-[12px] text-ink-faint" data-testid="tag-count">
                  {interpolate(zhTW.tagPage.count, { count: showing.total })}
                </p>
                {showing.events.length === 0 ? (
                  <EmptyDay title={zhTW.tagPage.noResults} />
                ) : (
                  <div data-testid="tag-result-rows">
                    {showing.events.map((event) => (
                      <EventRow
                        key={event.id}
                        event={event}
                        timezone={baby.timezone}
                        drafted={stopDrafts.some((draft) => draft.eventId === event.id)}
                        today={today}
                        from={here}
                      />
                    ))}
                  </div>
                )}
                {failure !== null ? (
                  <Failed failure={failure} onRetry={() => void loadMore()} />
                ) : showing.hasMore ? (
                  <button
                    type="button"
                    disabled={more}
                    onClick={() => void loadMore()}
                    data-testid="tag-more"
                    className="mt-3 min-h-11 w-full rounded-xl border border-line text-sm text-ink-muted disabled:opacity-60"
                  >
                    {zhTW.tagPage.more}
                  </button>
                ) : null}
              </>
            )}
          </section>
        ) : null}
      </div>

      {confirming ? (
        <ConfirmDelete
          tag={confirming}
          waiting={unsynced.filter((entry) => (entry.input.tagIds ?? []).includes(confirming.id)).length}
          countUses={async () => (await loadTagged({
            tagIds: [confirming.id], sort: 'recent', offset: 0, limit: 1,
          })).total}
          onCancel={() => setConfirming(null)}
          // Nothing here un-chooses the tag. `chosen` already leaves out any
          // id the device no longer has a tag for, which covers this and the
          // other parent deleting it as well; a second mechanism for the
          // same thing would be one nobody could see working.
          onDelete={async () => {
            await deleteTag(confirming.id);
            setManaging(null);
            setConfirming(null);
          }}
          onGone={() => setManaging(null)}
        />
      ) : null}
    </div>
  );
}

function Failed({ failure, onRetry }: { failure: unknown; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-6" data-testid="tag-failed">
      <p className="text-sm text-ink-muted">{zhTW.tagPage.failed}</p>
      <p className="text-xs text-ink-dim">{describeFailure(failure)}</p>
      <button
        type="button"
        onClick={onRetry}
        data-testid="tag-retry"
        className="min-h-11 rounded-xl border border-line px-4 text-sm text-ink-muted"
      >
        {zhTW.tagPage.retry}
      </button>
    </div>
  );
}

/**
 * Spec 7.9's confirmation: say the tag is in use, and what confirming does
 * to the records carrying it.
 *
 * The count is asked of the server when the sheet opens, not worked out
 * from this device's records, because it is a claim about every record --
 * the other parent's included -- and the device may not hold all of them.
 * A count it could not get is said rather than guessed: "not in use" on a
 * failed request would be the worst wrong answer this sheet could give.
 *
 * Records still in this phone's queue are counted separately and said
 * separately. The server cannot see them, and deleting the tag costs them
 * something real: it refuses a tag that no longer exists.
 */
function ConfirmDelete({ tag, waiting, countUses, onCancel, onDelete, onGone }: {
  tag: StoredTag;
  waiting: number;
  countUses: () => Promise<number>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
  onGone: () => void;
}): React.JSX.Element {
  const [uses, setUses] = useState<number | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    countUses()
      .then((n) => { if (!cancelled) setUses(n); })
      .catch(() => { if (!cancelled) setCountFailed(true); });
    return () => { cancelled = true; };
    // Asked once per sheet: it is opened for one tag and closed after, and
    // `countUses` is a new closure on every render of the screen behind it.
  }, []);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await onDelete();
    } catch (error) {
      if (error instanceof ApiFailure && error.code === 'NOT_FOUND') {
        // Deleted already, by the other phone. Not this press's doing, so
        // not reported as a deletion -- but the outcome somebody wanted is
        // the one there is.
        setGone(true);
        onGone();
      } else {
        setFailure(error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end">
      <button
        type="button"
        aria-label={zhTW.tagPage.cancel}
        onClick={onCancel}
        className="flex-1 bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-delete-title"
        className="rounded-t-2xl border-t border-line bg-surface px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        data-testid="tag-delete-confirm"
      >
        <p id="tag-delete-title" className="mb-2 text-[15px] font-medium">
          {interpolate(zhTW.tagPage.confirmTitle, { name: tag.name })}
        </p>

        {gone ? (
          <p className="mb-3 text-sm text-ink-muted" data-testid="tag-gone">{zhTW.tagPage.gone}</p>
        ) : (
          <>
            <p className="mb-2 text-xs leading-relaxed text-ink-muted" data-testid="tag-delete-impact">
              {countFailed
                ? zhTW.tagPage.countFailed
                : uses === null
                  ? zhTW.tagPage.checking
                  : uses > 0
                    ? interpolate(zhTW.tagPage.inUse, { count: uses })
                    : zhTW.tagPage.notInUse}
            </p>
            {waiting > 0 ? (
              <p className="mb-2 text-xs leading-relaxed text-warn-soft" data-testid="tag-delete-waiting">
                {interpolate(zhTW.tagPage.inUseHere, { count: waiting })}
              </p>
            ) : null}
            <ErrorLine failure={failure} />
          </>
        )}

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="tag-delete-cancel"
            className="min-h-11 flex-1 rounded-xl border border-line text-sm text-ink-muted"
          >
            {zhTW.tagPage.cancel}
          </button>
          {gone ? null : (
            // Not offered until the count is in. Confirming before the
            // sheet has said what will happen is not confirming anything.
            <button
              type="button"
              disabled={busy || uses === null}
              onClick={() => void confirm()}
              data-testid="tag-delete-yes"
              className="min-h-11 flex-1 rounded-xl bg-red-400/90 text-sm font-bold text-ground disabled:opacity-60"
            >
              {zhTW.tagPage.confirmDelete}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
