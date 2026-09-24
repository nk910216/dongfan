import { useState } from 'react';
import { zhTW } from '@dongfan/shared';
import type { MeDto } from '@dongfan/shared';
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
 * 404.
 *
 * And doubt, once it is here, is sticky (spec 6.1). A send that got no
 * answer may well have landed; if the account cannot be asked either, the
 * only honest state is "not known", and it has to survive the press that
 * comes after. Letting the next 404 settle it would report a failed join
 * to somebody who is already a member -- a used code and one that never
 * existed answer identically, which is the whole reason this cannot be
 * read off the refusal.
 */
export function JoinBaby(): React.JSX.Element {
  const { me, joinBaby, reload, selectBaby } = useSession();

  const [code, setCode] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);

  /** Set when a send ended with nothing from the server. Sticky. */
  const [unsure, setUnsure] = useState(false);

  /**
   * The babies this account had before the first attempt.
   *
   * Kept rather than compared against the list as it stands, because the
   * question is asked again on a later press, by which time the list may
   * have moved for reasons of its own. Without it, "did a new one appear"
   * has no fixed thing to be measured against.
   */
  const [before, setBefore] = useState<string[] | null>(null);

  const appeared = (fresh: MeDto, was: string[]): string | null =>
    fresh.babies.find((baby) => !was.includes(baby.id))?.id ?? null;

  const settle = (babyId: string): void => {
    setJoined(babyId);
    setUnsure(false);
    setCode('');
    selectBaby(babyId);
  };

  const submit = async (): Promise<void> => {
    setFailure(null);
    setBusy(true);

    // Both of these are held locally as well as in state, because state
    // read back inside this call is the value from before it started.
    // Every branch below turns on what has happened *during* this press.
    let landed = joined;
    let stillUnsure = unsure;
    const was = before ?? (me?.babies ?? []).map((baby) => baby.id);

    try {
      // Already in, and only the refresh is outstanding. Sending the code
      // again would spend nothing and return a 404: it has been used, by
      // this very person.
      if (landed !== null) {
        await reload();
        selectBaby(landed);
        return;
      }

      // In doubt: ask the account before sending anything. If the earlier
      // attempt landed, the code is spent and this is the only way to
      // find out; sending it again would answer 404 and say the opposite
      // of the truth.
      if (stillUnsure) {
        let fresh: MeDto;
        try {
          fresh = await reload();
        } catch {
          // Still nothing to ask. The doubt stands, which is the point of
          // it being sticky.
          setFailure(zhTW.settings.joinUnknown);
          return;
        }

        const found = appeared(fresh, was);
        if (found !== null) {
          settle(found);
          return;
        }

        // The account has been read and this person is not in it, so the
        // earlier send did not land. Sending again is now a fair test,
        // and whatever it answers is the answer.
        stillUnsure = false;
        setUnsure(false);
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
        stillUnsure = true;
        setUnsure(true);
        setBefore(was);

        // Try to settle it now rather than leaving somebody looking at a
        // maybe. If the account cannot be reached either, the doubt is
        // kept and the next press starts by asking again.
        try {
          const fresh = await reload();
          const found = appeared(fresh, was);
          if (found !== null) {
            settle(found);
            return;
          }
          stillUnsure = false;
          setUnsure(false);
          setFailure(zhTW.settings.joinFailed);
        } catch {
          setFailure(zhTW.settings.joinUnknown);
        }
        return;
      }

      // Reaching here means the doubt has already been settled, if there
      // was one: a press that started in doubt either found the baby and
      // returned, or could not ask and returned, or read the account
      // clean -- which is what makes this refusal a fair answer rather
      // than the same thing a code spent by this very person would say.
      //
      // A code that never existed, one already used and one that expired
      // all answer identically, deliberately: which of the three it was
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
        // Frozen once the code has been spent, or while it may have been:
        // what is left to do is find out, and retyping anything here
        // cannot help with that (spec 6.1).
        disabled={joined !== null || unsure}
        onChange={(e) => { setCode(e.target.value); setFailure(null); }}
        className="mb-2 w-full rounded-xl border border-line bg-surface px-4 py-3.5 font-numeric text-base tracking-wider outline-none focus:border-ink-faint disabled:opacity-60"
      />

      <ErrorLine failure={failure} />

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || (joined === null && !unsure && code.trim() === '')}
        data-testid="join"
        className="min-h-11 w-full rounded-xl border border-line text-sm text-ink-muted disabled:opacity-50"
      >
        {busy ? zhTW.settings.joining : zhTW.settings.join}
      </button>
    </>
  );
}
