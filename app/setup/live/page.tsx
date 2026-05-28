/**
 * Live-account setup walkthrough. Server-rendered HTML, no client JS.
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Set up a live Banca Transilvania trading account with bt-gateway',
  description:
    'Step-by-step guide to connecting your real bt-trade.ro account to bt-gateway: SMS-OTP forwarding via iOS Shortcuts + ntfy, credential setup in the dashboard, API key creation, and connecting Claude via MCP.',
  alternates: { canonical: `${SITE_URL}/setup/live` },
  openGraph: {
    url: `${SITE_URL}/setup/live`,
    title: 'Set up a live Banca Transilvania account with bt-gateway',
    description:
      'Connect your real BT Trade account to bt-gateway with SMS-OTP forwarding and stable refresh-token sessions.',
  },
};

const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Set up a live Banca Transilvania account with bt-gateway',
  description:
    'How to connect a real bt-trade.ro live trading account to bt-gateway, including SMS-OTP forwarding, credential setup, API key creation, and optional Claude MCP connection.',
  totalTime: 'PT15M',
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Prerequisites',
      text: 'Have an active bt-trade.ro account, a mobile phone receiving BT SMS OTPs, and a Google account for the bt-gateway dashboard.',
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Install the SMS-forwarding shortcut',
      text: 'Install the ntfy iOS app and create a Shortcuts automation triggered on SMS from BT that POSTs the message body to your ntfy topic.',
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Configure credentials',
      text: 'Sign in to the bt-gateway dashboard with Google, switch to live mode, enter your BT username and password (envelope-encrypted with Cloud KMS), copy the displayed ntfy topic into the SMS-forwarder.',
    },
    {
      '@type': 'HowToStep',
      position: 4,
      name: 'First login',
      text: 'Trigger any read endpoint; BT sends an SMS, your phone forwards it to ntfy, bt-gateway picks it up and completes the login.',
    },
    {
      '@type': 'HowToStep',
      position: 5,
      name: 'Generate API keys (optional)',
      text: 'In Settings, create bvb_live_… API keys for scripts. Scope each key with market/currency/symbol filters and a read-only or read+write access level.',
    },
    {
      '@type': 'HowToStep',
      position: 6,
      name: 'Connect Claude via MCP (optional)',
      text: 'In Claude → Settings → Connectors → Add custom connector, paste the bt-gateway /mcp URL, walk the OAuth flow, and pick the live mode plus the desired access level.',
    },
  ],
};

export default function SetupLivePage() {
  return (
    <MarketingShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToLd) }}
      />

      <article>
        <header>
          <h1>
            Set up your{' '}
            <span
              className="pill live"
              style={{ fontSize: '1.5rem', verticalAlign: 'middle' }}
            >
              live
            </span>{' '}
            account
          </h1>
          <p className="lead">
            Connect bt-gateway to your real Banca Transilvania trading account. Orders
            placed through this account move actual money. If you just want to experiment,
            use the <a href="/setup/demo">paper-trading setup</a> instead.
          </p>
        </header>

        <section aria-labelledby="step-prereqs">
          <h2 id="step-prereqs">1. Prerequisites</h2>
          <ul>
            <li>
              An active{' '}
              <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a>{' '}
              account that can log in via the web UI today.
            </li>
            <li>A mobile phone receiving BT&apos;s SMS one-time passwords. Required on every fresh login.</li>
            <li>A Google account for signing into <a href="/console">bt-gateway&apos;s dashboard</a>.</li>
          </ul>
        </section>

        <section aria-labelledby="step-sms">
          <h2 id="step-sms">2. Install the SMS-forwarding shortcut</h2>
          <p>
            BT prompts for an SMS OTP whenever a fresh login is required. bt-gateway listens
            for that OTP on a per-account{' '}
            <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> topic, so we
            need your phone to forward incoming BT SMS bodies to that topic.
          </p>
          <h3>iOS</h3>
          <ol>
            <li>
              Install the{' '}
              <a
                href="https://apps.apple.com/app/ntfy/id1625396347"
                target="_blank"
                rel="noreferrer"
              >
                ntfy iOS app
              </a>{' '}
              (free).
            </li>
            <li>Open Shortcuts → Automation → New → <strong>Message</strong>.</li>
            <li>
              Trigger: <strong>From contact</strong> → add BT&apos;s sender ID (typically{' '}
              <code>BT</code> or <code>BT24</code>); <strong>Message contains</strong> →
              leave blank; <strong>Run immediately</strong> on.
            </li>
            <li>
              Action: <strong>Get contents of URL</strong> →{' '}
              <code>https://ntfy.sh/&lt;your-topic&gt;</code>, method POST, request body =
              the message text.
            </li>
          </ol>
          <h3>Android</h3>
          <p className="dim">
            Use Tasker or MacroDroid with an &ldquo;SMS Received&rdquo; trigger and a
            matching HTTP POST action. The ntfy app also has a built-in &ldquo;Send
            notifications via HTTP POST&rdquo; doc that walks through the recipe.
          </p>
        </section>

        <section aria-labelledby="step-creds">
          <h2 id="step-creds">3. Configure credentials</h2>
          <ol>
            <li>Open <a href="/console">the dashboard</a> and sign in with Google.</li>
            <li>
              Go to <strong>Settings → Credentials</strong>, switch the global toggle to{' '}
              <span className="pill live">live</span>, and enter your BT username + password.
              They are envelope-encrypted with Cloud KMS before being stored.
            </li>
            <li>The dashboard shows the ntfy topic name your phone needs to post to — copy it into the Shortcut you set up in step 2.</li>
          </ol>
        </section>

        <section aria-labelledby="step-login">
          <h2 id="step-login">4. First login</h2>
          <p>
            Trigger any read endpoint (e.g. the dashboard&apos;s{' '}
            <strong>Refresh account data</strong> button) to kick off the first login. BT
            will send an SMS, your phone forwards it to ntfy, bt-gateway picks it up
            automatically, and the dashboard refreshes. After this, the refresh-token cycle
            keeps you signed in — no more OTPs until you switch IPs or BT invalidates the
            session.
          </p>
        </section>

        <section aria-labelledby="step-keys">
          <h2 id="step-keys">5. Generate API keys (optional)</h2>
          <p>
            Under <strong>Settings → Access</strong>, create a <code>bvb_live_…</code> key
            for any scripts or iOS Shortcuts that should drive the account. You can scope
            each key with market / currency / symbol allow- and deny-lists, and choose
            between read-only and read + write at creation.
          </p>
        </section>

        <section aria-labelledby="step-mcp">
          <h2 id="step-mcp">6. Connect Claude via MCP (optional)</h2>
          <p>
            In Claude → <strong>Settings → Connectors → Add custom connector</strong>, paste:
          </p>
          <pre className="mono-block">https://bt-gateway.bogdanripa.com/mcp</pre>
          <p>
            Claude walks the OAuth flow. Pick <strong>live</strong>, optionally inherit
            filters from an existing API key, and choose <strong>read-only</strong> or{' '}
            <strong>read + place orders</strong>. Be deliberate here — read + write on a
            live account means Claude can move real money.
          </p>
        </section>

        <div className="notice" style={{ marginTop: '2.5rem' }}>
          Ready? <a href="/console">Open the dashboard →</a>
        </div>
      </article>
    </MarketingShell>
  );
}
