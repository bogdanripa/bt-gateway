/**
 * Global demo/live mode context.
 *
 * The header switch is the single source of truth for "which BT mode am I
 * looking at right now?". Every page that previously had its own per-component
 * mode toggle (dashboard snapshot, API keys, credentials) reads from here.
 *
 * Persisted to localStorage so a page refresh doesn't yank the user back to
 * demo. Defaults to demo on first visit — picking live should be deliberate.
 */


import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Mode = 'demo' | 'live';

const STORAGE_KEY = 'bt-gateway:mode';

interface ModeContextValue {
  mode: Mode;
  setMode: (m: Mode) => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>('demo');

  // Restore from localStorage on mount. We start with 'demo' on the SSR pass
  // so hydration doesn't mismatch — then bump to whatever was saved.
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === 'demo' || v === 'live') setModeState(v);
    } catch {
      /* sandbox / private mode — no-op */
    }
  }, []);

  function setMode(m: Mode) {
    setModeState(m);
    try { window.localStorage.setItem(STORAGE_KEY, m); }
    catch { /* no-op */ }
  }

  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used within a ModeProvider');
  return ctx;
}
