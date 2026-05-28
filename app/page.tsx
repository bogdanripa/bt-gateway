/**
 * Marketing landing for bt-gateway. Server-rendered to static HTML — no
 * `'use client'`, no client-side React, no JS dependencies. Pure semantic
 * HTML for users, search engines, and AI crawlers alike.
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'bt-gateway — REST + MCP gateway for Banca Transilvania trading',
  description:
    'Connect Banca Transilvania trading accounts (live and paper) to scripts, iOS Shortcuts, and AI assistants like Claude. REST API + MCP server with stable refresh-token sessions, per-key filters, and OAuth-bound MCP connections.',
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: {
    url: `${SITE_URL}/`,
    title: 'bt-gateway — REST + MCP gateway for Banca Transilvania trading',
    description:
      'Use your BT Trade account from scripts or Claude. Stable refresh-token sessions, per-key filters, OAuth-bound MCP connections.',
  },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: 'bt-gateway',
      inLanguage: 'en',
      description:
        'A multi-tenant HTTP gateway in front of Banca Transilvania\'s BT Trade platform, exposing REST API and MCP server endpoints.',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'bt-gateway',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      url: `${SITE_URL}/`,
      description:
        'REST API and MCP server for Banca Transilvania trading accounts (BT Trade / bt-trade.ro). Supports both live trading and paper-trading (demo) accounts. Connect Claude and other MCP clients via OAuth 2.1 with PKCE.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
      featureList: [
        'REST API for cash, holdings, orders, and instrument lookup',
        'Order placement with preview, market, and limit support',
        'MCP server for Claude and other AI assistants',
        'OAuth 2.1 with PKCE for MCP authorization',
        'Per-API-key filters (markets, currencies, symbols)',
        'Stable refresh-token sessions on a reserved static egress IP',
        'Cloud KMS envelope-encrypted credentials at rest',
        'Optional per-tenant Telegram bot for audit alerts',
      ],
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'bt-gateway',
      url: `${SITE_URL}/`,
      sameAs: ['https://github.com/bogdanripa/bt-gateway'],
    },
  ],
};

export default function LandingPage() {
  return (
    <MarketingShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <article>
        <header>
          <h1>A stable bridge between you and BT Trade.</h1>
          <p className="lead">
            <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">BT Trade</a>{' '}
            (Banca Transilvania&apos;s retail trading platform) has no public API and pins
            refresh tokens to the IP that issued them. <strong>bt-gateway</strong> is a
            multi-tenant HTTP gateway that keeps a single, stable identity alive on your
            behalf — and exposes your account through clean, modern interfaces: a REST API
            for scripts, and a Model Context Protocol (MCP) server for AI assistants like
            Claude.
          </p>

          <div className="cta-row">
            <a href="/setup/live" className="button-link">
              Set up a live account →
            </a>
            <a
              href="/setup/demo"
              className="button-link"
              style={{
                background: 'transparent',
                color: 'var(--fg)',
                border: '1px solid var(--border)',
              }}
            >
              Set up a paper account →
            </a>
          </div>
        </header>

        <section aria-labelledby="account-types">
          <h2 id="account-types">Pick the account you want to connect</h2>
          <div className="feature-grid">
            <a href="/setup/live" className="card setup-card">
              <h3>
                <span className="pill live" style={{ marginRight: '0.5rem' }}>live</span>
                Real money
              </h3>
              <p className="dim">
                For your existing Banca Transilvania trading account. SMS-based two-factor
                authentication on every fresh login. Orders move real money — use this when
                you&apos;re ready to run live.
              </p>
            </a>
            <a href="/setup/demo" className="card setup-card">
              <h3>
                <span className="pill demo" style={{ marginRight: '0.5rem' }}>paper</span>
                Demo / paper trading
              </h3>
              <p className="dim">
                Free virtual account you create on bt-trade.ro. Email-based two-factor
                authentication. Same APIs and MCP tools, zero financial risk — ideal for
                first-time setup or strategy testing.
              </p>
            </a>
          </div>
        </section>

        <section aria-labelledby="why">
          <h2 id="why">Why bt-gateway</h2>
          <div className="feature-grid">
            <div className="card">
              <h3>Stable session, always</h3>
              <p className="dim">
                Runs on Google Cloud Run with a reserved static egress IP and a single warm
                instance so BT&apos;s refresh window never gets wasted. You sign in once;
                the gateway keeps the token alive.
              </p>
            </div>
            <div className="card">
              <h3>REST API for scripts</h3>
              <p className="dim">
                Read cash, holdings, and orders. Preview or place trades. Authenticate with
                a per-user API key (separate prefixes for demo and live — a compromised demo
                key can&apos;t touch live by construction).
              </p>
            </div>
            <div className="card">
              <h3>MCP for AI assistants</h3>
              <p className="dim">
                Connect Claude (or any MCP client) and let it inspect your portfolio, look
                up instruments, and place trades — within filters and the read/write scope
                you grant during OAuth consent.
              </p>
            </div>
            <div className="card">
              <h3>Defense in depth</h3>
              <p className="dim">
                Credentials are envelope-encrypted with Google Cloud KMS. API keys are
                stored as SHA-256 hashes. Every mutating action is audited and (optionally)
                pushed to your own Telegram bot. No shared service tokens, no plaintext at
                rest.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="how-it-fits">
          <h2 id="how-it-fits">How it fits together</h2>
          <ul>
            <li>
              <strong>API keys</strong> — bearer tokens (
              <code>bvb_demo_…</code> / <code>bvb_live_…</code>) for scripts, cron jobs, and
              iOS Shortcuts. Per-key filters by market, currency, or symbol.
            </li>
            <li>
              <strong>MCP connector</strong> — OAuth-bound, one connection at a time per
              mode. Same filter rules; same audit feed.
            </li>
            <li>
              <strong>Dashboard</strong> — Firebase-authenticated UI for credentials, keys,
              Telegram bot, and the audit log.
            </li>
          </ul>
        </section>

        <p className="dim" style={{ marginTop: '2rem', fontSize: '0.85rem' }}>
          bt-gateway is not affiliated with Banca Transilvania or BT Capital Partners. It
          proxies calls to bt-trade.ro on your behalf, using credentials you supply. Use at
          your own risk and within BT&apos;s terms of service.
        </p>
      </article>
    </MarketingShell>
  );
}
