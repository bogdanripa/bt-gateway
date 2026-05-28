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
    default: 'BT Gateway — connect Claude (or any app) to your BT Trade account',
    template: '%s · BT Gateway',
  },
  description:
    'BT Gateway connects your Banca Transilvania trading account to Claude and other AI assistants, and offers a clean REST API for scripts. Works with both live and free demo accounts.',
  applicationName: 'BT Gateway',
  authors: [{ name: 'Bogdan Ripa', url: 'https://github.com/bogdanripa' }],
  keywords: [
    'bt-trade',
    'Banca Transilvania',
    'BVB',
    'Bursa de Valori Bucuresti',
    'Claude',
    'AI trading assistant',
    'MCP',
    'Model Context Protocol',
    'trading API',
    'REST API',
    'demo account',
    'paper trading',
  ],
  openGraph: {
    type: 'website',
    siteName: 'BT Gateway',
    locale: 'en_US',
    title: 'BT Gateway — connect Claude to your BT Trade account',
    description:
      'Bring your Banca Transilvania trading account into Claude. Ask about your portfolio, look at positions, and place orders &mdash; live or demo. REST API also included.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BT Gateway — connect Claude to your BT Trade account',
    description:
      'Bring your Banca Transilvania trading account into Claude. Works with live and demo.',
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
