import { useState } from 'react';
import { zhTW } from '@dongfan/shared';
import { ApiFailure } from '../lib/api.js';
import { ErrorLine, describeFailure } from './FieldErrors.js';
import { useSession } from '../lib/session.js';

/**
 * Taking a code somebody sent and joining their baby.
 *
 * In two places, because there are two moments it is needed. The settings
 * page is where spec 7.1 puts it; the create-a-baby screen is where the
 * second parent actually is, holding a code, with no baby of their own and
 * therefore no settings page to reach. Offering only the first would make
 * the whole feature unusable for the thing it exists for.
 */
export function JoinBaby(): React.JSX.Element {
  const { joinBaby } = useSession();
  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  const submit = async (): Promise<void> => {
    setFailure(null);
    setJoined(false);
    setBusy(true);
    try {
      await joinBaby(code);
      setJoined(true);
      setCode('');
    } catch (error) {
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
        onChange={(e) => { setCode(e.target.value); setFailure(null); }}
        className="mb-2 w-full rounded-xl border border-line bg-surface px-4 py-3.5 font-numeric text-base tracking-wider outline-none focus:border-ink-faint"
      />

      <ErrorLine failure={failure} />
      {joined ? (
        <p className="mb-2 text-sm text-accent" data-testid="joined">{zhTW.settings.joined}</p>
      ) : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || code.trim() === ''}
        data-testid="join"
        className="min-h-11 w-full rounded-xl border border-line text-sm text-ink-muted disabled:opacity-50"
      >
        {busy ? zhTW.settings.joining : zhTW.settings.join}
      </button>
    </>
  );
}
