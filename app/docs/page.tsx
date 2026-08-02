/**
 * Public docs hub. Server-rendered HTML, no client JS. Bridges the
 * marketing landing to the deep setup guides for live + demo accounts,
 * plus a short reference for the REST and AI-assistant surfaces and an
 * FAQ block (schema.org FAQPage for SEO + GEO).
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Docs — BT Gateway for Claude and the BT Trade REST API',
  description:
    'Reference for BT Gateway: connect Claude (and other AI assistants) to your Banca Transilvania trading account, plus REST API endpoints, per-key filters, security model, and FAQ.',
  alternates: { canonical: `${SITE_URL}/docs` },
  openGraph: {
    url: `${SITE_URL}/docs`,
    title: 'Docs — BT Gateway',
    description:
      'How to connect Claude to your BT account, REST API reference, and security model.',
  },
};

const faqLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is BT Gateway?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'BT Gateway is a small service that lets Claude and other AI assistants talk to your Banca Transilvania trading account, and also offers a clean REST API for scripts. You can connect either your real (live) account or a free demo account.',
      },
    },
    {
      '@type': 'Question',
      name: 'Do I need a real BT Trade account?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'No. You can create a free demo trading account directly on bt-trade.ro and use it with BT Gateway. The demo account behaves like the real one but uses play money, so it\'s a safe way to try things out.',
      },
    },
    {
      '@type': 'Question',
      name: 'How does BT Gateway sign in to BT on my behalf?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'You enter your BT username and password into the dashboard once; they are encrypted at rest. The first sign-in needs a one-time code (SMS for live, email for demo) that a small automation on your phone forwards over. After that the connection stays alive automatically.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I connect Claude?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'In Claude, go to Settings → Connectors → Add custom connector and paste the BT Gateway /mcp URL. Claude opens a sign-in window; sign in with Google, pick demo or live, and choose read-only or "can place orders".',
      },
    },
    {
      '@type': 'Question',
      name: 'Can I limit what Claude or an API key can do?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. Every connection (and every API key) can be set to read-only or read + place orders, and you can restrict it to specific markets, currencies, or symbols. Read-only connections cannot place orders even if the targeted symbol is allowed.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is BT Gateway affiliated with Banca Transilvania?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'No. BT Gateway is an independent tool. It uses credentials you supply to act on your behalf on bt-trade.ro. Your use of BT itself is governed by BT\'s own terms.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where is my data stored?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'On a dedicated self-hosted server, in a private database that is not reachable from the public internet. BT credentials and Telegram bot tokens are encrypted with AES-256-GCM envelope encryption. API keys are stored as one-way hashes &mdash; the raw key is shown exactly once at creation.',
      },
    },
  ],
};

export default function DocsPage() {
  return (
    <MarketingShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />

      <article>
        <header>
          <h1>Docs</h1>
          <p className="lead">
            BT Gateway connects your Banca Transilvania trading account to AI assistants
            like Claude, and also gives you a simple REST API for scripts. Pick the kind
            of account you want to connect first.
          </p>
        </header>

        <section aria-labelledby="get-started">
          <h2 id="get-started">Get started</h2>
          <div className="feature-grid" style={{ marginTop: '0.5rem' }}>
            <a href="/setup/demo" className="card setup-card">
              <h3>
                <span className="pill demo" style={{ marginRight: '0.5rem' }}>demo</span>
                Set up a demo account
              </h3>
              <p className="dim">
                Create a free demo trading account on bt-trade.ro. Email codes,
                play-money balance, zero risk &mdash; ideal for trying things out.
              </p>
              <p style={{ marginTop: '0.5rem', color: 'var(--accent)' }}>Step-by-step guide →</p>
            </a>
            <a href="/setup/live" className="card setup-card">
              <h3>
                <span className="pill live" style={{ marginRight: '0.5rem' }}>live</span>
                Set up a live account
              </h3>
              <p className="dim">
                Connect your real BT Trade account. SMS codes on every fresh sign-in,
                real-money orders. Recommend trying the demo flow first.
              </p>
              <p style={{ marginTop: '0.5rem', color: 'var(--accent)' }}>Step-by-step guide →</p>
            </a>
          </div>
        </section>

        <section aria-labelledby="claude">
          <h2 id="claude">Connecting Claude</h2>
          <p>
            BT Gateway speaks the Model Context Protocol (MCP) at <code>/mcp</code> — the
            open standard Claude and other modern AI tools use to talk to apps. To add
            the connector:
          </p>
          <ol>
            <li>In Claude, open <strong>Settings → Connectors → Add custom connector</strong>.</li>
            <li>
              Paste <code>https://bt-gateway.bogdanripa.com/mcp</code> (or your own
              deployment&apos;s URL).
            </li>
            <li>
              Claude opens a sign-in window. Sign in with Google, pick demo or live,
              optionally inherit filters from an existing API key, and choose read-only
              or read + place orders.
            </li>
            <li>
              Revoke the connector any time from <a href="/console/settings">Settings</a>{' '}
              — it cuts off Claude&apos;s access immediately.
            </li>
          </ol>
          <p>
            What Claude can do today: see your cash balance and holdings, look at open
            and recent orders, look up instruments and markets, preview an order without
            placing it, and (if you grant write access) place orders.
          </p>
        </section>

        <section aria-labelledby="rest">
          <h2 id="rest">REST API</h2>
          <p>
            For scripts, iOS Shortcuts, or your own app, authenticate every call with{' '}
            <code>Authorization: Bearer bvb_&lt;mode&gt;_&lt;token&gt;</code>. Generate
            keys under <strong>Settings → Access</strong> after you&apos;ve set up at
            least one account. The mode is baked into the key prefix: a{' '}
            <code>bvb_demo_…</code> key can only touch the demo account; a{' '}
            <code>bvb_live_…</code> key can only touch the live one.
          </p>
          <h3>Common endpoints</h3>
          <ul>
            <li><code>GET /api/v1/cash</code> — cash balances</li>
            <li><code>GET /api/v1/holdings</code> — open positions and P&amp;L</li>
            <li><code>GET /api/v1/orders</code> — orders, filterable by status / side / symbol / date</li>
            <li><code>POST /api/v1/orders/preview</code> — try an order without sending it</li>
            <li><code>POST /api/v1/orders</code> — place an order (read+write keys only)</li>
            <li><code>GET /api/v1/markets</code> and <code>GET /api/v1/instruments/:symbol</code> — reference data</li>
          </ul>
          <p className="dim">
            Each key can carry per-axis allow/deny lists (markets, currencies, symbols),
            so a sandboxed key sees a sandboxed view.
          </p>
        </section>

        <section aria-labelledby="security">
          <h2 id="security">Security model</h2>
          <ul>
            <li>Your BT credentials and Telegram bot token are encrypted at rest with AES-256-GCM envelope encryption.</li>
            <li>API keys are stored as one-way hashes &mdash; the raw key is shown exactly once at creation.</li>
            <li>Every order, sign-in, and credential change shows up in your own audit log.</li>
            <li>Live and demo are fully isolated &mdash; separate credentials, separate keys, separate connections. A demo key cannot touch live money, by construction.</li>
            <li>Connecting an AI assistant requires you to be signed in to the dashboard with Google &mdash; nothing is added without your explicit consent.</li>
          </ul>
        </section>

        <section aria-labelledby="faq">
          <h2 id="faq">FAQ</h2>
          <dl>
            <dt><strong>What is BT Gateway?</strong></dt>
            <dd>
              A small service that lets Claude and other AI assistants talk to your
              Banca Transilvania trading account, and also offers a REST API for scripts.
            </dd>
            <dt><strong>Do I need a real BT Trade account?</strong></dt>
            <dd>
              No. You can create a free <a href="/setup/demo">demo trading account</a> on
              bt-trade.ro and connect that. The demo behaves like the real account but
              uses play money.
            </dd>
            <dt><strong>How does BT Gateway sign in to BT?</strong></dt>
            <dd>
              You enter your BT username and password into the dashboard once; they are
              encrypted at rest. The first sign-in needs a one-time code (SMS for live,
              email for demo) that a small automation on your phone forwards over. After
              that, the connection stays alive automatically.
            </dd>
            <dt><strong>Can I limit what Claude can do?</strong></dt>
            <dd>
              Yes. Each connection can be read-only or read + place orders, and you can
              restrict it to specific markets, currencies, or symbols.
            </dd>
            <dt><strong>Is BT Gateway affiliated with Banca Transilvania?</strong></dt>
            <dd>No. It&apos;s an independent tool that acts on your behalf using credentials you provide.</dd>
          </dl>
        </section>

        <p className="dim" style={{ marginTop: '2rem' }}>
          See <a href="/privacy">Privacy</a> and <a href="/terms">Terms</a> for the legal
          piece. Source on{' '}
          <a href="https://github.com/bogdanripa/bt-gateway" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </article>
    </MarketingShell>
  );
}
