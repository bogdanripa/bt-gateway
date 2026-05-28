/**
 * Shared chrome for the public-facing pages at `/`, `/setup/*`, `/docs`,
 * `/privacy`, `/terms`.
 *
 * Server component. No `'use client'`, no React hooks, no Firebase imports —
 * so a request for any of these pages renders to plain static HTML with no
 * JS bundle of consequence. Uses native `<a>` anchors (rather than
 * `next/link`) so each click is a real navigation, not a client-side route
 * transition.
 */

import type { ReactNode } from 'react';

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="nav">
        <a href="/" className="nav-brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>BT Gateway</span>
        </a>
        <a href="/setup/live">Live setup</a>
        <a href="/setup/demo">Demo setup</a>
        <a href="/docs">Docs</a>
        <span className="spacer" />
        <a href="/console" className="button-link">Console →</a>
      </header>
      <main className="container marketing">{children}</main>
      <footer className="marketing-footer">
        <div
          className="container"
          style={{
            display: 'flex',
            gap: '1.5rem',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            padding: '1.5rem 1.25rem',
          }}
        >
          <span className="muted">BT Gateway</span>
          <span className="spacer" style={{ flex: 1 }} />
          <a href="/docs">Docs</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="https://github.com/bogdanripa/bt-gateway" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
      </footer>
    </>
  );
}
