import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiRequest } from './api.js';
import { ApiFailure } from './api.js';
import type { BabyDto, LoginDto, MeDto } from '@dongfan/shared';

/**
 * Who is signed in.
 *
 * The token is an opaque session id the server can revoke, so keeping it in
 * localStorage costs nothing that a cookie would save: it is not a password
 * and it carries no claims (spec 9.2). It survives a reload, which is the
 * point, and iOS may still evict it (spec 9.6).
 */

const TOKEN_KEY = 'dongfan.session';
const ME_KEY = 'dongfan.me';

/** Storage throws in a private window rather than returning null. */
function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // An app that cannot remember the session still works for this visit.
  }
}

/**
 * The last account the server described.
 *
 * Kept so the app opens without a network. The token already survives a
 * reload; refusing to get past the sign-in screen because the *description*
 * of the account could not be fetched would be an invented restriction, and
 * it is exactly the moment -- no signal, one hand, three in the morning --
 * when being asked to sign in again is worst.
 *
 * Only ever a fallback. A reachable server always wins, and an answer of
 * "not signed in" clears it.
 */
type CachedMe = { token: string; me: MeDto };

/**
 * Stored with the token it was fetched for.
 *
 * Without that pairing, a cache left by one session could be shown to the
 * next -- a different account, or the same account after being removed from
 * a baby -- for as long as the server takes to answer.
 */
function readMe(token: string | null): MeDto | null {
  if (token === null) return null;
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (raw === null) return null;
    const cached = JSON.parse(raw) as CachedMe;
    return cached.token === token ? cached.me : null;
  } catch {
    return null;
  }
}

function writeMe(token: string | null, me: MeDto | null): void {
  try {
    if (me === null || token === null) localStorage.removeItem(ME_KEY);
    else localStorage.setItem(ME_KEY, JSON.stringify({ token, me } satisfies CachedMe));
  } catch {
    // The app still works for this visit; it just will not open without
    // waiting for the server next time.
  }
}

export type SessionState = {
  token: string | null;
  me: MeDto | null;
  /** True until the stored token has been checked against the server. */
  loading: boolean;
  /** True when the account shown came from storage, not from the server. */
  offline: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Refetches the account and its babies, after one has been created. */
  reload: () => Promise<void>;
  /**
   * Joins a baby somebody shared a code for.
   *
   * Here rather than in the store because what it changes is the account:
   * which babies this person can see at all. The store is built for one of
   * them and cannot be the thing that adds another (spec 6.5).
   */
  joinBaby: (code: string) => Promise<BabyDto>;
  /** Called when any request comes back unauthenticated. */
  expire: () => void;
};

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [me, setMe] = useState<MeDto | null>(null);
  const [loading, setLoading] = useState(token !== null);
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const expire = useCallback(() => {
    writeToken(null);
    writeMe(null, null);
    setToken(null);
    setMe(null);
    setOffline(false);
    setLoading(false);
  }, []);

  // A stored token may have been revoked or may simply have expired, so it
  // is not trusted until the server answers.
  useEffect(() => {
    if (token === null) {
      setMe(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    // Shown straight away when we have it, and checked in the background.
    //
    // Waiting for /me before rendering anything meant a slow connection --
    // not a failed one, a slow one -- held the whole app on a loading
    // screen with the records sitting on the device. A request that never
    // answers holds it there for ever.
    const remembered = readMe(token);
    if (remembered) {
      setMe(remembered);
      setOffline(true);
      setLoading(false);
    } else {
      setLoading(true);
    }

    apiRequest<MeDto>('/me', { token })
      .then((body) => {
        if (cancelled) return;
        writeMe(token, body);
        setMe(body);
        setOffline(false);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // Only the server saying so ends a session, and it ends it even if
        // the cached account is already on screen. Anything else is the
        // network, and being signed out by a tunnel would be absurd.
        if (error instanceof ApiFailure && error.status === 401) {
          expire();
          return;
        }

        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, expire, attempt]);

  /**
   * Reads the account again, after a baby has been created.
   *
   * The token comes from state, not from storage. Signing in works with
   * nothing but memory -- every write to storage is allowed to fail -- and
   * reading the token back from a store that refused to keep it would
   * return nothing, leaving the caller waiting for a refresh that never
   * happens (spec 9.6).
   */
  const reload = useCallback(async (): Promise<void> => {
    if (token === null) return;
    const body = await apiRequest<MeDto>('/me', { token });
    writeMe(token, body);
    setMe(body);
    setOffline(false);
    setAttempt((n) => n + 1);
  }, [token]);

  const joinBaby = useCallback(
    async (code: string): Promise<BabyDto> => {
      const joined = await apiRequest<BabyDto>('/babies/join', {
        method: 'POST',
        token: token ?? undefined,
        body: { code },
      });
      // The account's baby list is what decides what the app shows, so it
      // has to be read again before any of this is visible.
      await reload();
      return joined;
    },
    [token, reload],
  );

  const signIn = useCallback(async (username: string, password: string) => {
    const body = await apiRequest<LoginDto>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    // A different person signing in must not inherit the last one's
    // account description while their own is being fetched.
    writeMe(null, null);
    setMe(null);
    writeToken(body.token);
    setToken(body.token);
  }, []);

  const signOut = useCallback(() => {
    const current = readToken();
    // Best effort: the local session goes either way, because a user who
    // taps sign out on a train should not stay signed in.
    if (current) void apiRequest('/auth/logout', { method: 'POST', token: current }).catch(() => undefined);
    expire();
  }, [expire]);

  const value = useMemo<SessionState>(
    () => ({ token, me, loading, offline, signIn, signOut, expire, reload, joinBaby }),
    [token, me, loading, offline, signIn, signOut, expire, reload, joinBaby],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession used outside SessionProvider');
  return session;
}
