import { useState } from 'react';
import { isPlausibleBirthDate, toLocalDate, zhTW } from '@dongfan/shared';
import type { BabyDto } from '@dongfan/shared';
import { apiRequest } from '../lib/api.js';
import { describeFailure } from '../components/FieldErrors.js';
import { useSession } from '../lib/session.js';
import { newClientId } from '../lib/ids.js';

/**
 * The first thing a new account sees, and the only way past it.
 *
 * An account with no baby cannot record anything, and there is nothing else
 * for this screen to be: a message saying "ask someone to make one" would
 * be a dead end on a freshly deployed database, where the owner is the only
 * person there is.
 *
 * A second parent does not come through here. They are added to an existing
 * baby from the account CLI, and will have one by the time they sign in
 * (spec 12).
 */
export function CreateBaby(): React.JSX.Element {
  const { token, reload } = useSession();

  // Generated once and reused, so pressing the button again after a failure
  // reaches the same record. A duplicate baby is worse than a duplicate
  // event: nothing merges them, and every record afterwards goes to
  // whichever one the app happens to pick (spec 5.8).
  const [babyId] = useState(newClientId);
  // Set as soon as the server has answered. After that the button is only
  // retrying the account refresh, and must not send the creation again.
  const [created, setCreated] = useState(false);

  const [nickname, setNickname] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('other');
  // Defaulted to today in the only timezone this version supports, which is
  // also the one the server will store the baby with (spec 5.3).
  const [birthDate, setBirthDate] = useState(() => toLocalDate(Date.now(), 'Asia/Taipei'));
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);

    if (nickname.trim() === '') {
      setFailure(zhTW.fieldError.REQUIRED);
      return;
    }
    // Checked here as well as on the server: the date control will hand
    // over a day that does not exist, and a round trip to be told so is a
    // poor way to learn it.
    if (!isPlausibleBirthDate(birthDate, Date.now(), 'Asia/Taipei')) {
      setFailure(zhTW.fieldError.INVALID_FORMAT);
      return;
    }

    setBusy(true);
    try {
      if (!created) {
        await apiRequest<BabyDto>('/babies', {
          method: 'POST',
          token: token ?? undefined,
          body: { id: babyId, nickname: nickname.trim(), gender, birthDate },
        });
        // Remembered before anything else can fail. The refresh below is a
        // separate request with its own way of going wrong, and pressing
        // the button after it did would otherwise send the creation a
        // second time.
        setCreated(true);
      }

      // The account's baby list comes from /me, so it has to be read again
      // before anything below can find one.
      await reload();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-center px-7">
      <h1 className="mb-1 text-center text-xl font-bold tracking-wide">{zhTW.baby.createTitle}</h1>
      <p className="mb-7 text-center text-sm leading-relaxed text-ink-faint">{zhTW.baby.createHint}</p>

      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <fieldset disabled={created} className="contents">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.nickname}</span>
          <input
            name="nickname"
            value={nickname}
            onChange={(e) => { setNickname(e.target.value); setFailure(null); }}
            placeholder={zhTW.baby.nicknamePlaceholder}
            className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.gender}</span>
          <div className="flex gap-2">
            {(['male', 'female', 'other'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setGender(option)}
                aria-pressed={gender === option}
                className="min-h-11 flex-1 rounded-xl border py-3 text-sm"
                style={
                  gender === option
                    ? { borderColor: '#E8B15C', borderWidth: 1.5, backgroundColor: '#E8B15C22', color: '#E8B15C' }
                    : { borderColor: '#2E2921', backgroundColor: '#1C1915', color: '#C9C0B2' }
                }
              >
                {zhTW.baby[option]}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.baby.birthDate}</span>
          <input
            type="date"
            aria-label={zhTW.baby.birthDate}
            value={birthDate}
            onChange={(e) => { setBirthDate(e.target.value); setFailure(null); }}
            className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
          />
        </label>
        </fieldset>

        {created ? (
          <p className="text-xs leading-relaxed text-amber-300/90" data-testid="created-pending-refresh">
            {zhTW.baby.createdNeedsRefresh}
          </p>
        ) : null}

        {failure !== null ? (
          <p className="text-sm text-red-300" data-testid="form-error">{describeFailure(failure)}</p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          data-testid="submit"
          className="mt-2 min-h-11 rounded-2xl bg-accent py-4 text-base font-bold text-ground disabled:opacity-60"
        >
          {busy ? zhTW.baby.creating : created ? zhTW.error.retry : zhTW.baby.create}
        </button>
      </form>
    </div>
  );
}
