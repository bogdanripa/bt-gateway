/**
 * Public docs hub. Server-rendered HTML, no client JS. Bridges the
 * marketing landing to the deep setup guides for live + demo accounts,
 * plus a short reference for the REST and MCP surfaces and an FAQ block
 * (structured as schema.org FAQPage for SEO + GEO).
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Docs — bt-gateway REST API and MCP server for BT Trade',
  description:
    'Reference for bt-gateway: REST API endpoints (cash, holdings, orders, instruments, markets), MCP server with OAuth 2.1 + PKCE, per-key filters, and security model. Setup guides for live and demo Banca Transilvania accounts.',
  alternates: { canonical: `${SITE_URL}/docs` },
  openGraph: {
    url: `${SITE_URL}/docs`,
    title: 'Docs — bt-gateway REST API and MCP server for BT Trade',
    description:
      'REST API and MCP server reference, plus setup guides for live and paper-trading accounts.',
  },
};

const faqLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is bt-gateway?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'bt-gateway is an unofficial multi-tenant HTTP gateway in front of bt-trade.ro (Banca Transilvania\'s retail trading platform). It exposes your BT Trade account as a REST API and as a Model Context Protocol (MCP) server, with stable refresh-token sessions, per-API-key filters, and Cloud KMS envelope-encrypted credentials at rest.',
      },
    },
    {
      '@type': 'Question',
      name: 'Do I need a real BT Trade account?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'No. You can create a free demo (paper-trading) account directly on bt-trade.ro and connect it to bt-gateway. Demo accounts use email-based two-factor authentication, while live accounts use SMS. Both surfaces — REST API and MCP — work identically across the two modes.',
      },
    },
    {
      '@type': 'Question',
      name: 'How does bt-gateway authenticate to BT Trade on my behalf?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'You provide your BT username and password once. They are envelope-encrypted with Google Cloud KMS and used to log in. The login completes when a one-time code is delivered (SMS for live, email for demo) and forwarded to a per-account ntfy topic by a small iOS Shortcut or Gmail bridge. From then on, the refresh-token cycle keeps the session alive on Cloud Run\'s reserved static egress IP.',
      },
    },
    {
      '@type': 'Question',
      name: 'How do I connect Claude or another AI assistant?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'bt-gateway exposes a Model Context Protocol (MCP) server at /mcp, authenticated via OAuth 2.1 with PKCE. In Claude → Settings → Connectors → Add custom connector, paste the bt-gateway /mcp URL. Claude walks the OAuth flow: you sign in with Google, pick demo or live, optionally inherit filters from an existing API key, and choose read-only or read + place orders.',
      },
    },
    {
      '@type': 'Question',
      name: 'Can I restrict what an MCP connector or API key can do?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Yes. Every API key (and every MCP connection) carries optional include/exclude filters on three axes: market, currency, and instrument symbol. Both reads and mutations respect those filters. Additionally, each key has a read-only or read+write access level — read-only keys cannot place orders, even if the targeted symbol is allowed.',
      },
    },
    {
      '@type': 'Question',
      name: 'Is bt-gateway affiliated with Banca Transilvania?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'No. bt-gateway is an independent, unofficial tool operated by Bogdan Ripa. It proxies authenticated calls to bt-trade.ro on your behalf using credentials you supply. Your use of bt-trade.ro itself is governed by BT\'s terms of service.',
      },
    },
    {
      '@type': 'Question',
      name: 'Where is my data stored?',
      acceptedAnswer: {
        '@type': 'Answer',
        text:
          'Everything tenant-scoped lives in Google Firestore in region europe-west3. BT credentials and Telegram bot tokens are envelope-encrypted with Cloud KMS. API keys are stored as SHA-256 hashes — the raw key is shown exactly once at creation. See the Privacy page for the full data inventory and retention details.',
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
            bt-gateway runs in front of{' '}
            <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a>{' '}
            and gives you two stable interfaces into your account: a REST API for scripts
            and an MCP server for AI assistants. Pick the kind of account you want to
            connect first.
          </p>
        </header>

        <section aria-labelledby="get-started">
          <h2 id="get-started">Get started</h2>
          <div className="feature-grid" style={{ marginTop: '0.5rem' }}>
            <a href="/setup/live" className="card setup-card">
              <h3>
                <span className="pill live" style={{ marginRight: '0.5rem' }}>live</span>
                Set up a live account
              </h3>
              <p className="dim">
                Connect bt-gateway to your real BT Trade account. SMS-based 2FA on every
                fresh login. Orders place real money.
              </p>
              <p style={{ marginTop: '0.5rem', color: 'var(--accent)' }}>Step-by-step guide →</p>
            </a>
            <a href="/setup/demo" className="card setup-card">
              <h3>
                <span className="pill demo" style={{ marginRight: '0.5rem' }}>demo</span>
                Set up a paper-trading account
              </h3>
              <p className="dim">
                Create a free demo account on bt-trade.ro. Email-based 2FA. Zero financial
                risk — ideal for trying the API or wiring up Claude for the first time.
              </p>
              <p style={{ marginTop: '0.5rem', color: 'var(--accent)' }}>Step-by-step guide →</p>
            </a>
          </div>
        </section>

        <section aria-labelledby="rest">
          <h2 id="rest">REST API at a glance</h2>
          <p>
            Authenticate every call with{' '}
            <code>Authorization: Bearer bvb_&lt;mode&gt;_&lt;token&gt;</code>. Generate keys
            under <strong>Settings → Access</strong> after you&apos;ve set up at least one
            mode. The mode is fused into the prefix: a <code>bvb_demo_…</code> key can only
            touch demo sessions; a <code>bvb_live_…</code> key can only touch live.
          </p>
          <h3>Common endpoints</h3>
          <ul>
            <li><code>GET /api/v1/cash</code> — cash balances across evaluation currencies</li>
            <li><code>GET /api/v1/holdings</code> — open positions with marks &amp; unrealized P&amp;L</li>
            <li><code>GET /api/v1/orders</code> — orders, filterable by status / side / symbol / date</li>
            <li><code>POST /api/v1/orders/preview</code> — preflight an order without placing it</li>
            <li><code>POST /api/v1/orders</code> — place an order (read+write keys only)</li>
            <li><code>GET /api/v1/markets</code> &amp; <code>GET /api/v1/instruments/:symbol</code> — reference data</li>
          </ul>
          <p className="dim">
            Per-key <strong>filters</strong> can restrict a key to specific markets,
            currencies, or symbols — include &amp; exclude lists on each axis. Both reads and
            writes respect them, so a sandboxed key sees a sandboxed view.
          </p>
        </section>

        <section aria-labelledby="mcp">
          <h2 id="mcp">MCP for Claude (and friends)</h2>
          <p>
            bt-gateway speaks the Model Context Protocol over Streamable HTTP at{' '}
            <code>/mcp</code>, authenticated via OAuth 2.1 with PKCE. To add the connector
            in Claude:
          </p>
          <ol>
            <li>Open <strong>Settings → Connectors → Add custom connector</strong>.</li>
            <li>Paste <code>https://bt-gateway.bogdanripa.com/mcp</code> (or your own deployment&apos;s URL).</li>
            <li>Claude walks the OAuth flow: you sign in with Google, pick demo or live, optionally inherit filters from an existing API key, and choose read-only or read + place orders.</li>
            <li>Revoke the connector any time from <a href="/console/settings">Settings</a> — it revokes the underlying API key in one shot.</li>
          </ol>
          <p>
            Tools currently exposed: <code>get_cash</code>, <code>get_holdings</code>,{' '}
            <code>list_orders</code>, <code>get_order</code>, <code>get_instrument</code>,{' '}
            <code>list_markets</code>, <code>preview_order</code> (read-only), and{' '}
            <code>place_order</code> (read + write only).
          </p>
        </section>

        <section aria-labelledby="security">
          <h2 id="security">Security model</h2>
          <ul>
            <li>BT credentials and Telegram bot tokens are envelope-encrypted with Cloud KMS.</li>
            <li>API keys are stored as SHA-256 hashes; the raw key is shown exactly once at creation.</li>
            <li>Mutating actions are audited per-tenant; reads live in Cloud Logging only.</li>
            <li>demo and live live in fully separate Firestore subtrees; mode is derived from the API-key prefix, never from a body parameter.</li>
            <li>The OAuth consent step is the only place a new MCP connector can be authorized — and Firebase sign-in is required to consent.</li>
          </ul>
        </section>

        <section aria-labelledby="faq">
          <h2 id="faq">FAQ</h2>
          <dl>
            <dt><strong>What is bt-gateway?</strong></dt>
            <dd>
              An unofficial multi-tenant HTTP gateway in front of bt-trade.ro. It exposes
              your BT Trade account as a REST API and as an MCP server for AI assistants.
            </dd>
            <dt><strong>Do I need a real BT Trade account?</strong></dt>
            <dd>
              No. You can create a free <a href="/setup/demo">demo (paper-trading)
              account</a> on bt-trade.ro and connect that. Demo accounts use email-based
              2FA, live accounts use SMS.
            </dd>
            <dt><strong>How does bt-gateway log into BT?</strong></dt>
            <dd>
              You provide your BT username and password once; they are envelope-encrypted
              with Cloud KMS. The first login requires a one-time code (SMS for live,
              email for demo) that a small iOS Shortcut forwards to a per-account ntfy
              topic. From then on, the refresh-token cycle keeps the session alive.
            </dd>
            <dt><strong>Can I restrict what an MCP connector can do?</strong></dt>
            <dd>
              Yes — per-axis filters (markets, currencies, symbols) plus a read-only vs.
              read + write access level chosen at OAuth consent time.
            </dd>
            <dt><strong>Is bt-gateway affiliated with Banca Transilvania?</strong></dt>
            <dd>
              No. It&apos;s an independent tool that proxies authenticated calls on your
              behalf using credentials you supply.
            </dd>
          </dl>
        </section>

        <p className="dim" style={{ marginTop: '2rem' }}>
          See <a href="/privacy">Privacy</a> and <a href="/terms">Terms</a> for the legal
          piece. The full source lives on{' '}
          <a href="https://github.com/bogdanripa/bt-gateway" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </article>
    </MarketingShell>
  );
}
