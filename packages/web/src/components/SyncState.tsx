import { zhTW } from '@dongfan/shared';
import { syncedAgo } from '../lib/format.js';
import { useStore } from '../lib/store.js';

/**
 * When it last caught up, and a way to make it try now.
 *
 * Spec 6.1 asks for a manual sync on the home screen **and** the calendar.
 * The automatic pulls cover coming back to the app and coming back online,
 * and neither covers standing in the kitchen wondering whether the other
 * parent has recorded the feed yet -- or sitting on last Tuesday while they
 * add something to it.
 *
 * One component, so the two screens cannot end up disagreeing about what
 * "synced" looks like. It reads and drives the store rather than fetching
 * anything: the calendar is a reader of IndexedDB, and a second way of
 * pulling would be a second cursor to get wrong (spec 5.4).
 */
export function SyncState({ now }: { now: number }): React.JSX.Element {
  const { stale, syncing, syncedAt, refresh } = useStore();

  return (
    <button
      type="button"
      onClick={() => void refresh()}
      disabled={syncing}
      aria-label={zhTW.a11y.sync}
      className="text-[13px] text-ink-faint disabled:opacity-60"
      data-testid="sync-state"
    >
      {syncing ? zhTW.home.syncing : stale ? zhTW.home.syncFailed : syncedAgo(syncedAt, now)}
    </button>
  );
}
