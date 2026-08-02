/**
 * Marketing landing for BT Gateway. Server-rendered to static HTML — no
 * `'use client'`, no client-side React, no JS dependencies. Pure semantic
 * HTML for users, search engines, and AI crawlers alike.
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'BT Gateway — let Claude (or any app) work with your BT Trade account',
  description:
    'Connect your Banca Transilvania trading account to Claude or other AI assistants. See your portfolio in chat, ask for analysis, and place orders by voice or text — for live or demo accounts. Plus a clean REST API for scripts.',
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: {
    url: `${SITE_URL}/`,
    title: 'BT Gateway — let Claude work with your BT Trade account',
    description:
      'Connect your Banca Transilvania trading account to Claude or other AI assistants. See your portfolio in chat, ask for analysis, and place orders — live or demo.',
  },
};

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: 'BT Gateway',
      inLanguage: 'en',
      description:
        'Connect a Banca Transilvania trading account to Claude and other AI assistants via the Model Context Protocol (MCP), plus a clean REST API.',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'BT Gateway',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'Web',
      url: `${SITE_URL}/`,
      description:
        'Bridge between your Banca Transilvania trading account and modern apps. Lets AI assistants like Claude check balances, look at positions, and place orders. Also provides a REST API for scripts. Works with both live trading and free demo accounts.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
      featureList: [
        'Chat with Claude about your portfolio',
        'Place trades from a conversation with an AI assistant',
        'Read cash, holdings, and orders',
        'Place orders with preview, market, and limit support',
        'Per-key filters (markets, currencies, symbols)',
        'Read-only vs. read + place orders permissions',
        'Works with both live and demo (paper-trading) accounts',
        'Optional Telegram alerts',
      ],
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'BT Gateway',
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
          <h1>Bring your BT Trade account to Claude.</h1>
          <p className="lead">
            BT Gateway is an{' '}
            <strong>
              <a
                href="https://modelcontextprotocol.io"
                target="_blank"
                rel="noreferrer"
              >
                MCP
              </a>{' '}
              connector
            </strong>{' '}
            that lets you ask{' '}
            <a href="https://claude.ai" target="_blank" rel="noreferrer">Claude</a> (or
            any other MCP-compatible AI assistant) about your Banca Transilvania trading
            account in plain language. &ldquo;What&apos;s my cash balance?&rdquo;
            &ldquo;Show me my positions.&rdquo; &ldquo;Place a buy order for 100 TVBETETF
            at market.&rdquo; Works with your real account, or a free demo account if
            you&apos;d rather try things out first.
          </p>

          <div className="mcp-url-card">
            <label htmlFor="mcp-url">MCP connector URL</label>
            <pre id="mcp-url" className="mono-block">https://bt-gateway.bogdanripa.com/mcp</pre>
            <p className="dim" style={{ fontSize: '0.85rem', margin: 0 }}>
              Paste this into Claude → <em>Settings → Connectors → Add custom connector</em>.
              You&apos;ll be walked through signing in and choosing what Claude can do.
            </p>
          </div>

          <div className="cta-row">
            <a href="/setup/demo" className="button-link">
              Set up a demo account →
            </a>
            <a href="/setup/live" className="button-link ghost">
              Set up a live account →
            </a>
          </div>
        </header>

        <section aria-labelledby="meet-claude">
          <h2 id="meet-claude">Your BT account, inside Claude</h2>
          <p>
            Add BT Gateway as a connector inside Claude and your trading account shows up
            as something Claude can see and act on. Ask it whatever you&apos;d normally
            think about &mdash; how your portfolio is doing today, what your largest
            position is, whether to take profits on a winner, or to place a specific
            order. Claude reads from your account and (if you let it) places trades on
            your behalf.
          </p>
          <p>
            Setup takes a couple of minutes. You sign in to Claude, point its connector
            at BT Gateway:
          </p>
          <pre className="mono-block" style={{ display: 'block', userSelect: 'all' }}>
            https://bt-gateway.bogdanripa.com/mcp
          </pre>
          <p>
            Then sign in here with Google, and choose:
          </p>
          <ul>
            <li>Whether Claude sees your <strong>live</strong> or <strong>demo</strong> account.</li>
            <li>Whether it&apos;s <strong>read-only</strong> (look but don&apos;t touch) or can <strong>place orders</strong>.</li>
            <li>Optional filters — limit Claude to specific markets, currencies, or symbols.</li>
          </ul>
          <p className="dim">
            You can revoke its access at any time from the dashboard.
          </p>
        </section>

        <section aria-labelledby="account-types">
          <h2 id="account-types">Live or demo — pick where to start</h2>
          <div className="feature-grid">
            <a href="/setup/demo" className="card setup-card">
              <h3>
                <span className="pill demo" style={{ marginRight: '0.5rem' }}>demo</span>
                Try it with a demo account
              </h3>
              <p className="dim">
                Create a free demo trading account on bt-trade.ro in a couple of clicks.
                Same experience as the real thing &mdash; same balances, charts, orders
                &mdash; just with play money. Perfect for trying Claude or BT Gateway for
                the first time, with zero financial risk.
              </p>
            </a>
            <a href="/setup/live" className="card setup-card">
              <h3>
                <span className="pill live" style={{ marginRight: '0.5rem' }}>live</span>
                Connect your real account
              </h3>
              <p className="dim">
                Already have a Banca Transilvania trading account? Connect it once and
                you can pull up your real portfolio in Claude any time. Orders place real
                money, so we recommend trying the demo flow first.
              </p>
            </a>
          </div>
        </section>

        <section aria-labelledby="for-devs">
          <h2 id="for-devs">For developers: a clean API</h2>
          <p>
            If you&apos;d rather drive the account from a script, an iOS Shortcut, or
            your own app, BT Gateway also exposes a straightforward REST API. Generate
            an API key from the dashboard, point your code at the endpoints, and read
            cash, holdings, and orders or place trades. Each key can be scoped to specific
            markets, currencies, or symbols, and can be made read-only.
          </p>
          <p className="dim" style={{ fontSize: '0.85rem' }}>
            See the <a href="/docs">docs</a> for the endpoint reference.
          </p>
        </section>

        <section aria-labelledby="why">
          <h2 id="why">Why BT Gateway</h2>
          <div className="feature-grid">
            <div className="card">
              <h3>Made for AI assistants</h3>
              <p className="dim">
                Built around the Model Context Protocol &mdash; the open standard Claude
                and other modern AI tools use to talk to apps. No fragile screen-scraping,
                no flaky browser automation: a real connection your assistant understands.
              </p>
            </div>
            <div className="card">
              <h3>You stay in control</h3>
              <p className="dim">
                Every connection has a scope: live or demo, read-only or read + place
                orders, optional symbol / market / currency filters. Revoke any
                connection in one click from the dashboard.
              </p>
            </div>
            <div className="card">
              <h3>Solid security defaults</h3>
              <p className="dim">
                Your BT credentials are encrypted at rest with AES-256-GCM envelope
                encryption. API keys
                are stored hashed (we never see the raw value after creation). Every order
                placed on your behalf shows up in your own audit log &mdash; and
                optionally on your own Telegram bot.
              </p>
            </div>
            <div className="card">
              <h3>Live <em>and</em> demo support</h3>
              <p className="dim">
                Both account types are fully isolated &mdash; separate credentials,
                separate keys, separate connections. A demo connection physically cannot
                touch your real money, even if compromised.
              </p>
            </div>
          </div>
        </section>

        <p className="dim" style={{ marginTop: '2rem', fontSize: '0.85rem' }}>
          BT Gateway is not affiliated with Banca Transilvania or BT Capital Partners. It
          uses credentials you provide to act on your behalf on bt-trade.ro. Use at your
          own risk and within BT&apos;s terms of service.
        </p>
      </article>
    </MarketingShell>
  );
}
