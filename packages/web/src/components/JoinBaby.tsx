import { useState } from 'react';
import { zhTW } from '@dongfan/shared';
import { ApiFailure } from '../lib/api.js';
import { ErrorLine, describeFailure } from './FieldErrors.js';
import { outcomeIsUnknown } from '../lib/outcome.js';
import { useSession } from '../lib/session.js';

/**
 * Taking a code somebody sent and joining their baby.
 *
 * In two places, because there are two moments it is needed. The settings
 * page is where spec 7.1 puts it; the create-a-baby screen is where the
 * second parent actually is, holding a code, with no baby of their own and
 * therefore no settings page to reach. Offering only the first would make
 * the whole feature unusable for the thing it exists for.
 *
 * Two requests, and they fail separately. Spending the code is one; asking
 * the account which babies it can now see is the other. Joining them meant
 * a failed refresh looked exactly like a failed join -- while the code was
 * already spent, so pressing the button again could only ever collect a
 * 404. What is remembered here is which of the two still has to happen.
 */
export function JoinBaby(): React.JSX.Element {
  const { me, joinBaby, reload, selectBaby } = useSession();

  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);

  /**
   * Reads the account and says whether a baby that was not there before
   * has appeared.
   *
   * The recovery for a request that got no answer. The code may well have
   * been spent -- asking is the only way to find out, and it is a great
   * deal better than telling somebody it failed while they are already a
   * member (spec 6.1).
   */
  const appeared = async (): Promise<string | null> => {
    const before = new Set((me?.babies ?? []).map((baby) => baby.id));
    const fresh = await reload();
    return fresh.babies.find((baby) => !before.has(baby.id))?.id ?? null;
  };

  const submit = async (): Promise<void> => {
    setFailure(null);
    setBusy(true);

    // Held locally as well as in state, because state read back inside
    // this call is the value from before it started. Without it, a
    // refresh that failed a moment after the code was spent reports that
    // nothing is known -- when what is known is that they are in.
    let landed = joined;

    try {
      // Already in, and only the refresh is outstanding. Sending the code
      // again would spend nothing and return a 404: it has been used, by
      // this very person.
      if (landed !== null) {
        await reload();
        selectBaby(landed);
        return;
      }

      const baby = await joinBaby(code);
      landed = baby.id;
      setJoined(baby.id);
      setCode('');
      await reload();
      // Straight to the baby they asked for. Landing on a different one
      // because it happens to be first in the list is not what they did.
      selectBaby(baby.id);
    } catch (error) {
      if (landed !== null) {
        setFailure(zhTW.settings.joinedNeedsRefresh);
        return;
      }

      if (outcomeIsUnknown(error)) {
        // Nothing came back, so the code may or may not have been spent.
        const found = await appeared().catch(() => null);
        if (found !== null) {
          setJoined(found);
          setCode('');
          selectBaby(found);
          return;
        }
        setFailure(zhTW.settings.joinUnknown);
        return;
      }

      // A code that never existed, one already used and one that expired
      // all answer the same way, deliberately: which of the three it was
      // is something only somebody guessing would want to know (spec 6.5).
      setFailure(
        error instanceof ApiFailure && error.status === 404
          ? zhTW.settings.joinFailed
          : describeFailure(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-3 text-[11px] leading-relaxed text-ink-dim">{zhTW.settings.joinHint}</p>

      <input
        aria-label={zhTW.settings.joinPlaceholder}
        placeholder={zhTW.settings.joinPlaceholder}
        value={code}
        // Frozen once the code has been spent: what is left to do is a
        // refresh, and retyping anything here cannot help with that.
        disabled={joined !== null}
        onChange={(e) => { setCode(e.target.value); setFailure(null); }}
        className="mb-2 w-full rounded-xl border border-line bg-surface px-4 py-3.5 font-numeric text-base tracking-wider outline-none focus:border-ink-faint disabled:opacity-60"
      />

      <ErrorLine failure={failure} />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || (joined === null && code.trim() === '')}
        data-testid="join"
        className="min-h-11 w-full rounded-xl border border-line text-sm text-ink-muted disabled:opacity-50"
      >
        {busy ? zhTW.settings.joining : zhTW.settings.join}
      </button>
    </>
  );
}
