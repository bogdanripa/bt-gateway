/**
 * Provides { user, status, signIn, signOut, getIdToken } to the tree.
 *
 * `status` = 'loading' until Firebase has hydrated from its local cache
 * (resolves in a few ms but we must not flash the sign-in screen during it).
 */


import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import {
  onAuthChanged,
  signInWithGoogle,
  signOut as firebaseSignOut,
} from '@/lib/firebase/client';

type AuthStatus = 'loading' | 'signed-in' | 'signed-out';

interface AuthCtx {
  user: User | null;
  status: AuthStatus;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  useEffect(() => {
    const unsub = onAuthChanged((u) => {
      setUser(u);
      setStatus(u ? 'signed-in' : 'signed-out');
    });
    return () => unsub();
  }, []);

  return (
    <Ctx.Provider
      value={{
        user,
        status,
        signIn: async () => { await signInWithGoogle(); },
        signOut: async () => { await firebaseSignOut(); },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
