/**
 * Root HTML shell.
 *
 * Kept deliberately minimal so the marketing pages (`/`, `/setup/*`, `/docs`,
 * `/privacy`, `/terms`) render as plain static HTML — no Firebase script, no
 * auth providers, no client-side React beyond what each page opts into.
 *
 * Firebase initialization + the AuthProvider / ModeProvider context live in
 * `app/console/layout.tsx` (the dashboard) and `app/oauth/layout.tsx` (the
 * OAuth consent UI). Public pages don't pay for them.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BT_GATEWAY_PUBLIC_URL ?? 'https://bt-gateway.bogdanripa.com'),
  title: {
    default: 'bt-gateway — REST + MCP gateway for Banca Transilvania trading',
    template: '%s · bt-gateway',
  },
  description:
    'bt-gateway is a multi-tenant HTTP gateway in front of bt-trade.ro. It exposes BT Trade as a REST API and as an MCP server for AI assistants like Claude, with stable refresh-token sessions, per-key filters, and OAuth-bound MCP connections.',
  applicationName: 'bt-gateway',
  authors: [{ name: 'Bogdan Ripa', url: 'https://github.com/bogdanripa' }],
  keywords: [
    'bt-trade',
    'Banca Transilvania',
    'BVB',
    'Bursa de Valori Bucuresti',
    'trading API',
    'REST API',
    'MCP',
    'Model Context Protocol',
    'Claude',
    'AI trading',
    'paper trading',
    'demo account',
  ],
  openGraph: {
    type: 'website',
    siteName: 'bt-gateway',
    locale: 'en_US',
    title: 'bt-gateway — REST + MCP gateway for Banca Transilvania trading',
    description:
      'A stable bridge between you and BT Trade. Use it as a REST API, or connect Claude via MCP, with credential-grade encryption and per-key filters.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'bt-gateway — REST + MCP gateway for Banca Transilvania trading',
    description:
      'A stable bridge between you and BT Trade. Use it as a REST API, or connect Claude via MCP.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
