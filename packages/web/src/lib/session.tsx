import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiRequest } from './api.js';
import { ApiFailure } from './api.js';
import type { LoginDto, MeDto } from '@dongfan/shared';

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
function readMe(): MeDto | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    return raw === null ? null : (JSON.parse(raw) as MeDto);
  } catch {
    return null;
  }
}

function writeMe(me: MeDto | null): void {
  try {
    if (me === null) localStorage.removeItem(ME_KEY);
    else localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // The app still works for this visit; it just will not open offline.
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
    writeMe(null);
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
    setLoading(true);

    apiRequest<MeDto>('/me', { token })
      .then((body) => {
        if (cancelled) return;
        writeMe(body);
        setMe(body);
        setOffline(false);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // Only the server saying so ends a session. Anything else is the
        // network, and being signed out by a tunnel would be absurd.
        if (error instanceof ApiFailure && error.status === 401) {
          expire();
          return;
        }

        const remembered = readMe();
        if (remembered) {
          setMe(remembered);
          setOffline(true);
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
    writeMe(body);
    setMe(body);
    setOffline(false);
    setAttempt((n) => n + 1);
  }, [token]);

  const signIn = useCallback(async (username: string, password: string) => {
    const body = await apiRequest<LoginDto>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    // A different person signing in must not inherit the last one's
    // account description while their own is being fetched.
    writeMe(null);
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
    () => ({ token, me, loading, offline, signIn, signOut, expire, reload }),
    [token, me, loading, offline, signIn, signOut, expire, reload],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession used outside SessionProvider');
  return session;
}
