/**
 * Demo / paper-trading setup walkthrough. Server-rendered HTML, no client JS.
 *
 * BT&apos;s demo accounts are gated by EMAIL-based 2FA (not SMS), so the
 * OTP-forwarder uses a "filter inbox by sender" trigger.
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Set up a BT Trade paper / demo trading account with bt-gateway',
  description:
    'Create a free demo trading account on bt-trade.ro and connect it to bt-gateway: email-OTP forwarding via iOS Shortcuts + ntfy, credential setup, API key creation, and connecting Claude via MCP — with zero financial risk.',
  alternates: { canonical: `${SITE_URL}/setup/demo` },
  openGraph: {
    url: `${SITE_URL}/setup/demo`,
    title: 'Set up a BT Trade paper / demo account with bt-gateway',
    description:
      'Free paper-trading account on bt-trade.ro connected to bt-gateway. Email-OTP forwarding via ntfy. Run scripts and AI assistants like Claude at zero risk.',
  },
};

const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Set up a BT Trade paper / demo trading account with bt-gateway',
  description:
    'How to create a free demo (paper-trading) account on bt-trade.ro and connect it to bt-gateway. Includes email-OTP forwarding via ntfy, credential setup, API key creation, and Claude MCP integration.',
  totalTime: 'PT20M',
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Create the demo account',
      text: 'On bt-trade.ro switch from Live to Demo, choose "Create a new demo account", and finish the form. The activation email contains your demo username.',
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Install the email-forwarding shortcut',
      text: 'Install the ntfy iOS app and create a Shortcuts Email automation that triggers on the BT sender address and POSTs the email body to your ntfy topic. Alternatives include Gmail filters bridged via Apps Script or n8n.',
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Configure credentials',
      text: 'Sign in to the bt-gateway dashboard with Google, switch to demo mode, enter the BT demo username and password. Copy the displayed ntfy topic into the email-forwarder.',
    },
    {
      '@type': 'HowToStep',
      position: 4,
      name: 'First login',
      text: 'Trigger any read endpoint; BT emails the OTP, your forwarder posts it to ntfy, and bt-gateway picks it up to complete the login.',
    },
    {
      '@type': 'HowToStep',
      position: 5,
      name: 'Generate API keys (optional)',
      text: 'Create a bvb_demo_… key in Settings. A compromised demo key cannot touch live trading — the mode is fused into the key prefix.',
    },
    {
      '@type': 'HowToStep',
      position: 6,
      name: 'Connect Claude via MCP',
      text: 'Add a custom connector in Claude pointing at the bt-gateway /mcp URL. Walk the OAuth flow, pick demo, and choose read-only or read + place orders.',
    },
  ],
};

export default function SetupDemoPage() {
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
              className="pill demo"
              style={{ fontSize: '1.5rem', verticalAlign: 'middle' }}
            >
              demo
            </span>{' '}
            account
          </h1>
          <p className="lead">
            BT&apos;s demo (paper-trading) accounts are independent of your real account —
            separate username, separate balance, and notably <strong>email-based</strong>{' '}
            two-factor authentication instead of SMS. Use this account to validate
            strategies, exercise the REST API, or let an AI assistant drive a portfolio with
            zero financial risk.
          </p>
        </header>

        <section aria-labelledby="step-create">
          <h2 id="step-create">1. Create the demo account</h2>
          <ol>
            <li>Open <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a>.</li>
            <li>On the sign-in screen, switch from <em>Live</em> to <em>Demo</em>.</li>
            <li>
              Choose <strong>Create a new demo account</strong>. You&apos;ll be asked for an
              email — this is where BT will send the OTP for every login.
            </li>
            <li>Finish the form and confirm the activation email. Note the username BT issued for the demo — you&apos;ll enter it into the dashboard later.</li>
          </ol>
        </section>

        <section aria-labelledby="step-email">
          <h2 id="step-email">2. Install the email-forwarding shortcut</h2>
          <p>
            Because demo OTPs arrive by email rather than SMS, the forwarder watches your
            inbox for messages from BT and posts the OTP body to a per-account{' '}
            <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> topic.
            bt-gateway picks it up and completes the login.
          </p>
          <h3>iOS — Shortcuts + Mail</h3>
          <ol>
            <li>
              Install the{' '}
              <a
                href="https://apps.apple.com/app/ntfy/id1625396347"
                target="_blank"
                rel="noreferrer"
              >
                ntfy iOS app
              </a>
              .
            </li>
            <li>Open Shortcuts → Automation → New → <strong>Email</strong>.</li>
            <li>
              Trigger: <strong>Sender</strong> = the address BT uses to send the OTP
              (typically something like <code>noreply@bt-trade.ro</code>). Filtering by
              sender alone is the most reliable.
            </li>
            <li>
              Action: <strong>Get contents of URL</strong> →{' '}
              <code>https://ntfy.sh/&lt;your-topic&gt;</code>, method POST, request body =
              the email body. The Shortcuts &ldquo;Email&rdquo; trigger exposes the body via
              the <em>Shortcut Input</em> variable.
            </li>
            <li>Turn off <em>Ask Before Running</em> so the OTP forwards instantly.</li>
          </ol>
          <h3>Gmail (any platform)</h3>
          <p className="dim">
            Set up a Gmail filter: <strong>From: noreply@bt-trade.ro</strong> →{' '}
            <em>Apply label bt-otp</em>. Then wire a small bridge (Google Apps Script,
            Pipedream, n8n) that polls the label and POSTs new bodies to{' '}
            <code>https://ntfy.sh/&lt;your-topic&gt;</code>. Push notifications via webhooks
            work too — most modern inbox-automation tools support an HTTP POST action.
          </p>
        </section>

        <section aria-labelledby="step-creds">
          <h2 id="step-creds">3. Configure credentials</h2>
          <ol>
            <li>Open <a href="/console">the dashboard</a> and sign in with Google.</li>
            <li>
              Go to <strong>Settings → Credentials</strong>, switch the global toggle to{' '}
              <span className="pill demo">demo</span>, and enter the username + password
              from step 1.
            </li>
            <li>The dashboard shows the ntfy topic name — copy it into the email-forwarder you set up in step 2.</li>
          </ol>
        </section>

        <section aria-labelledby="step-login">
          <h2 id="step-login">4. First login</h2>
          <p>
            Trigger any read endpoint to kick off the first login. BT emails the OTP, your
            forwarder posts it to ntfy, bt-gateway picks it up automatically. After this,
            the refresh-token cycle keeps the session alive — no further OTPs until BT
            invalidates it or you change IPs.
          </p>
        </section>

        <section aria-labelledby="step-keys">
          <h2 id="step-keys">5. Generate API keys (optional)</h2>
          <p>
            Under <strong>Settings → Access</strong>, create a <code>bvb_demo_…</code> key.
            A compromised demo key cannot touch live trading — the mode is fused into the
            key prefix and verified at every request. Demo keys are the safest place to
            experiment with the REST API and to wire up a first-time MCP connector.
          </p>
        </section>

        <section aria-labelledby="step-mcp">
          <h2 id="step-mcp">6. Connect Claude via MCP</h2>
          <p>
            In Claude → <strong>Settings → Connectors → Add custom connector</strong>, paste:
          </p>
          <pre className="mono-block">https://bt-gateway.bogdanripa.com/mcp</pre>
          <p>
            Walk the OAuth flow, pick <strong>demo</strong>, optionally inherit filters from
            an existing API key, and choose <strong>read-only</strong> or{' '}
            <strong>read + place orders</strong>. Since this is paper trading,{' '}
            <em>read + place</em> is a low-risk way to let Claude run a full end-to-end
            strategy.
          </p>
        </section>

        <div className="notice" style={{ marginTop: '2.5rem' }}>
          Ready? <a href="/console">Open the dashboard →</a>
        </div>
      </article>
    </MarketingShell>
  );
}
