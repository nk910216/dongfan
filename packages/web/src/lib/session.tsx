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

export type SessionState = {
  token: string | null;
  me: MeDto | null;
  /** True until the stored token has been checked against the server. */
  loading: boolean;
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
  const [attempt, setAttempt] = useState(0);

  const expire = useCallback(() => {
    writeToken(null);
    setToken(null);
    setMe(null);
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
        if (!cancelled) {
          setMe(body);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiFailure && error.status === 401) expire();
        else setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, expire, attempt]);

  const reload = useCallback(async (): Promise<void> => {
    const current = readToken();
    if (current === null) return;
    setMe(await apiRequest<MeDto>('/me', { token: current }));
    setAttempt((n) => n + 1);
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const body = await apiRequest<LoginDto>('/auth/login', {
      method: 'POST',
      body: { username, password },
    });
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
    () => ({ token, me, loading, signIn, signOut, expire, reload }),
    [token, me, loading, signIn, signOut, expire, reload],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession used outside SessionProvider');
  return session;
}
