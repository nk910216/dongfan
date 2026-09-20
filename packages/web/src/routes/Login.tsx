import { useState } from 'react';
import { errorMessage, zhTW } from '@dongfan/shared';
import { ApiFailure, NetworkFailure } from '../lib/api.js';
import { useSession } from '../lib/session.js';

/**
 * There is no registration screen. Accounts are made with the CLI, which is
 * the whole of the access control for a household app (spec 9.1).
 */
export function Login(): React.JSX.Element {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username, password);
    } catch (failure) {
      // The server never says which of the two was wrong, and neither does
      // this: it would turn the form into a way to test whether an account
      // exists (spec 9.4).
      if (failure instanceof NetworkFailure) setError(zhTW.error.offline);
      else if (failure instanceof ApiFailure) setError(errorMessage(failure.code));
      else setError(errorMessage('UNKNOWN'));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-center px-7">
      <h1 className="mb-1 text-center text-2xl font-bold tracking-wide">{zhTW.app.name}</h1>
      <p className="mb-8 text-center text-sm text-ink-faint">{zhTW.auth.title}</p>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.auth.username}</span>
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs tracking-wide text-ink-faint">{zhTW.auth.password}</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border border-line bg-surface px-4 py-3.5 text-base outline-none focus:border-ink-faint"
          />
        </label>

        {error ? <p className="text-sm text-red-300">{error}</p> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 min-h-11 rounded-2xl bg-accent py-4 text-base font-bold text-ground disabled:opacity-60"
        >
          {busy ? zhTW.auth.pending : zhTW.auth.submit}
        </button>
      </form>
    </div>
  );
}
