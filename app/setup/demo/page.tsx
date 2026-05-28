/**
 * Demo-account setup walkthrough. Server-rendered HTML, no client JS.
 *
 * BT&apos;s demo accounts use EMAIL-based two-factor authentication
 * (not SMS), so the OTP forwarder reads from your inbox.
 */

import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Set up a BT Trade demo account with BT Gateway',
  description:
    'Create a free demo (paper) trading account on bt-trade.ro and connect it to Claude or your own scripts via BT Gateway. Step-by-step setup, with email-based two-factor authentication and zero financial risk.',
  alternates: { canonical: `${SITE_URL}/setup/demo` },
  openGraph: {
    url: `${SITE_URL}/setup/demo`,
    title: 'Set up a BT Trade demo account with BT Gateway',
    description:
      'Free demo trading account on bt-trade.ro connected to BT Gateway. Try Claude, scripts, and the API at zero risk.',
  },
};

const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Set up a BT Trade demo account with BT Gateway',
  description:
    'How to create a free demo trading account on bt-trade.ro and connect it to BT Gateway. Includes setting up email-OTP forwarding, configuring credentials in the dashboard, and connecting Claude.',
  totalTime: 'PT20M',
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Create the demo account',
      text:
        'On bt-trade.ro switch from Live to Demo, choose "Create a new demo account", and finish the form. The activation email contains your demo username.',
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Forward BT login codes to BT Gateway',
      text:
        'BT sends a one-time code by email every time you sign in. A small Shortcuts automation (iPhone) or a Gmail filter forwards it to BT Gateway so login can complete automatically.',
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Add your credentials in the dashboard',
      text:
        'Sign in to the BT Gateway dashboard with Google, switch to demo, enter the BT username and password, and copy the forwarder URL shown there.',
    },
    {
      '@type': 'HowToStep',
      position: 4,
      name: 'First login',
      text:
        'Click "Refresh account data". BT emails the code, your forwarder hands it to BT Gateway, and the dashboard fills in.',
    },
    {
      '@type': 'HowToStep',
      position: 5,
      name: 'Connect Claude',
      text:
        'In Claude, add BT Gateway as a connector. Sign in with Google, pick demo, and choose read-only or "can place orders". Done.',
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
            Set up a{' '}
            <span
              className="pill demo"
              style={{ fontSize: '1.5rem', verticalAlign: 'middle' }}
            >
              demo
            </span>{' '}
            account
          </h1>
          <p className="lead">
            BT&apos;s demo accounts are a free, fully separate way to try out trading
            without putting real money on the line. Same screens as the live account,
            same prices and orders, just with play balance. If this is your first time
            with BT Gateway, start here.
          </p>
        </header>

        <section aria-labelledby="step-create">
          <h2 id="step-create">1. Create the demo account on bt-trade.ro</h2>
          <ol>
            <li>
              Open{' '}
              <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">
                bt-trade.ro
              </a>{' '}
              in your browser.
            </li>
            <li>On the sign-in screen, switch from <em>Live</em> to <em>Demo</em>.</li>
            <li>
              Click <strong>Create a new demo account</strong>. You&apos;ll be asked for an
              email address — this is where BT will send a one-time code every time you
              sign in.
            </li>
            <li>
              Finish the form and confirm the activation email. Note the username BT
              issued — you&apos;ll need it in step 3.
            </li>
          </ol>
        </section>

        <section aria-labelledby="step-email">
          <h2 id="step-email">2. Forward BT&apos;s login codes to BT Gateway</h2>
          <p>
            Each sign-in to BT requires a one-time code that arrives in your email. A
            tiny automation reads that email and hands the code to BT Gateway so login
            can complete without you copying it manually each time.
          </p>
          <h3>On iPhone (Shortcuts)</h3>
          <ol>
            <li>
              Install the{' '}
              <a
                href="https://apps.apple.com/app/ntfy/id1625396347"
                target="_blank"
                rel="noreferrer"
              >
                ntfy app
              </a>{' '}
              from the App Store.
            </li>
            <li>
              Open <strong>Shortcuts → Automation → New → Email</strong>.
            </li>
            <li>
              Set the trigger to fire when an email arrives from BT&apos;s sender address
              (typically <code>noreply@bt-trade.ro</code>).
            </li>
            <li>
              Add a <strong>Get contents of URL</strong> action: method POST, URL is the
              forwarder address shown on the BT Gateway dashboard (it looks like
              <code>https://ntfy.sh/&lt;something&gt;</code>), body is the email content.
            </li>
            <li>Turn off &ldquo;Ask Before Running&rdquo; so the code forwards instantly.</li>
          </ol>
          <h3>From Gmail (any phone or computer)</h3>
          <p className="dim">
            Set up a Gmail filter on <strong>From: noreply@bt-trade.ro</strong>, label it
            <em> bt-otp</em>, then use Apps Script, Pipedream, or n8n to POST new
            messages to the forwarder URL shown on your dashboard. Any &ldquo;email →
            webhook&rdquo; tool you already use works.
          </p>
        </section>

        <section aria-labelledby="step-creds">
          <h2 id="step-creds">3. Add your credentials in the dashboard</h2>
          <ol>
            <li>
              Open the <a href="/console">BT Gateway dashboard</a> and sign in with
              Google.
            </li>
            <li>
              Go to <strong>Settings → Credentials</strong>, switch the toggle at the top
              to <span className="pill demo">demo</span>, and enter the username and
              password from step 1.
            </li>
            <li>
              The dashboard shows your personal forwarder URL — copy it into the
              automation you set up in step 2.
            </li>
          </ol>
          <p className="dim">
            Your password is encrypted at rest. We never see it again after you enter it,
            and it&apos;s only used to sign in to your BT account on your behalf.
          </p>
        </section>

        <section aria-labelledby="step-login">
          <h2 id="step-login">4. First sign-in</h2>
          <p>
            Click <strong>Refresh account data</strong> in the dashboard. BT emails the
            one-time code, your forwarder posts it over, and BT Gateway completes the
            login. After this, the connection stays alive on its own &mdash; no more
            codes to type.
          </p>
        </section>

        <section aria-labelledby="step-claude">
          <h2 id="step-claude">5. Connect Claude</h2>
          <p>
            In{' '}
            <a href="https://claude.ai" target="_blank" rel="noreferrer">
              Claude
            </a>
            , go to <strong>Settings → Connectors → Add custom connector</strong>, and
            paste:
          </p>
          <pre className="mono-block">https://bt-gateway.bogdanripa.com/mcp</pre>
          <p>
            Claude opens a sign-in window. Sign in with Google, pick{' '}
            <strong>demo</strong>, and choose whether Claude can just look at your
            account (<em>read-only</em>) or also place orders. Since this is demo trading,
            allowing it to place orders is a low-risk way to try the full end-to-end
            experience.
          </p>
        </section>

        <section aria-labelledby="step-api">
          <h2 id="step-api">Optional: API keys for scripts</h2>
          <p>
            If you&apos;d like to drive the account from your own code, go to{' '}
            <strong>Settings → Access</strong> and create an API key. A key created on a
            demo account can only touch the demo account &mdash; it can never affect real
            money.
          </p>
        </section>

        <div className="notice" style={{ marginTop: '2.5rem' }}>
          Ready? <a href="/console">Open the dashboard →</a>
        </div>
      </article>
    </MarketingShell>
  );
}
