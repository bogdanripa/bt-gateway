/**
 * Renders the sign-in button when signed out, children when signed in,
 * and a neutral "…" during the initial hydration so we don't flash the
 * sign-in screen for a split second on every page load.
 *
 * Also kicks off a one-time `POST /api/ui/me` on first sign-in to ensure
 * the user record exists in the database.
 */


import { type ReactNode, useEffect, useRef } from 'react';
import { useAuth } from './AuthProvider';
import { uiFetch } from '@/lib/ui-client';

export function AuthGate({ children }: { children: ReactNode }) {
  const { user, status, signIn } = useAuth();
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (user && !bootstrapped.current) {
      bootstrapped.current = true;
      uiFetch('/api/ui/me', { method: 'POST' }).catch((e) => {
        // Non-fatal — the user is still authenticated; this just creates the
        // profile doc. Worst case, the next /api/ui/* call will retry it.
        console.warn('bootstrap /me failed:', e);
      });
    }
  }, [user]);

  if (status === 'loading') {
    return (
      <main className="container">
        <p className="dim">Loading…</p>
      </main>
    );
  }

  if (status === 'signed-out') {
    return (
      <main className="container" style={{ maxWidth: 420, textAlign: 'center', paddingTop: '6rem' }}>
        <img src="/icon.svg" alt="" width={48} height={48} style={{ marginBottom: '0.75rem' }} />
        <h1>BT Gateway</h1>
        <p className="dim">Sign in with Google to manage your BT Trade credentials and API keys.</p>
        <button onClick={() => { void signIn(); }} style={{ marginTop: '1.5rem' }}>
          Sign in with Google
        </button>
      </main>
    );
  }

  return <>{children}</>;
}
