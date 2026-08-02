/**
 * Live-account setup walkthrough. Server-rendered HTML, no client JS.
 */

import { MarketingShell } from '@/components/MarketingShell';




const howToLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  name: 'Set up a live Banca Transilvania account with BT Gateway',
  description:
    'How to connect your real bt-trade.ro account to BT Gateway. Includes SMS-code forwarding, credentials setup, and connecting Claude.',
  totalTime: 'PT15M',
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Prerequisites',
      text: 'Have an active bt-trade.ro account, a mobile phone that receives BT SMS codes, and a Google account for the BT Gateway dashboard.',
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Forward BT login codes to BT Gateway',
      text: 'Set up a small Shortcuts automation (iPhone) or Tasker macro (Android) that POSTs the body of any SMS from BT to your personal forwarder URL.',
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Add your credentials in the dashboard',
      text: 'Sign in to the BT Gateway dashboard, switch to live, enter your BT username and password, and paste the forwarder URL into the automation.',
    },
    {
      '@type': 'HowToStep',
      position: 4,
      name: 'First sign-in',
      text: 'Click Refresh account data. BT sends an SMS, the forwarder hands the code to BT Gateway, and the dashboard loads.',
    },
    {
      '@type': 'HowToStep',
      position: 5,
      name: 'Connect Claude (optional)',
      text: 'Add BT Gateway as a custom connector in Claude. Pick live and choose read-only or "can place orders". For a real-money account, read-only is the safer first step.',
    },
  ],
};

export function SetupLivePage() {
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
              className="pill live"
              style={{ fontSize: '1.5rem', verticalAlign: 'middle' }}
            >
              live
            </span>{' '}
            account
          </h1>
          <p className="lead">
            Connect BT Gateway to your real Banca Transilvania trading account. Orders
            placed through this account move real money &mdash; if you&apos;re just
            curious how things work, the{' '}
            <a href="/setup/demo">demo setup</a> is the safer place to start.
          </p>
        </header>

        <section aria-labelledby="step-prereqs">
          <h2 id="step-prereqs">1. Prerequisites</h2>
          <ul>
            <li>
              An active{' '}
              <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">
                bt-trade.ro
              </a>{' '}
              account you can sign into via the BT website today.
            </li>
            <li>The phone that receives BT&apos;s SMS codes on every sign-in.</li>
            <li>A Google account for the <a href="/console">BT Gateway dashboard</a>.</li>
          </ul>
        </section>

        <section aria-labelledby="step-sms">
          <h2 id="step-sms">2. Forward BT&apos;s SMS codes to BT Gateway</h2>
          <p>
            BT requires an SMS code each time a fresh login is needed. A tiny automation
            on your phone forwards that code to BT Gateway, so the sign-in completes
            without you copying anything manually.
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
              Open <strong>Shortcuts → Automation → New → Message</strong>.
            </li>
            <li>
              Set the trigger to <strong>From contact</strong> with BT&apos;s sender ID
              (typically <code>BT</code> or <code>BT24</code>), and turn on{' '}
              <strong>Run immediately</strong>.
            </li>
            <li>
              Add a <strong>Get contents of URL</strong> action: method POST, URL is the
              forwarder address shown on your BT Gateway dashboard, body is the SMS text.
            </li>
          </ol>
          <h3>On Android</h3>
          <p className="dim">
            Use Tasker or MacroDroid with an &ldquo;SMS Received&rdquo; trigger and a
            matching HTTP POST action.
          </p>
        </section>

        <section aria-labelledby="step-creds">
          <h2 id="step-creds">3. Add your credentials in the dashboard</h2>
          <ol>
            <li>Open the <a href="/console">BT Gateway dashboard</a> and sign in with Google.</li>
            <li>
              Go to <strong>Settings → Credentials</strong>, switch the toggle at the top
              to <span className="pill live">live</span>, and enter your BT username and
              password.
            </li>
            <li>The dashboard shows your personal forwarder URL — copy it into the automation you set up in step 2.</li>
          </ol>
          <p className="dim">
            Your password is encrypted at rest. We never see it again after you enter it,
            and it&apos;s only used to sign in to your BT account on your behalf.
          </p>
        </section>

        <section aria-labelledby="step-login">
          <h2 id="step-login">4. First sign-in</h2>
          <p>
            Click <strong>Refresh account data</strong>. BT sends an SMS, your phone
            forwards it over, and BT Gateway signs you in. After this, the connection
            stays alive on its own &mdash; no more codes to type.
          </p>
        </section>

        <section aria-labelledby="step-claude">
          <h2 id="step-claude">5. Connect Claude (optional)</h2>
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
            Sign in with Google when prompted, pick <strong>live</strong>, and choose
            whether Claude can just look (<em>read-only</em>) or also place orders. For
            a real-money account we suggest read-only at first &mdash; you can always
            grant write access later.
          </p>
        </section>

        <section aria-labelledby="step-api">
          <h2 id="step-api">Optional: API keys for scripts</h2>
          <p>
            If you want to drive the account from your own code, go to{' '}
            <strong>Settings → Access</strong> and create an API key. Each key can be
            scoped to specific markets, currencies, or symbols, and you can make it
            read-only so it can&apos;t place orders even if it leaks.
          </p>
        </section>

        <div className="notice" style={{ marginTop: '2.5rem' }}>
          Ready? <a href="/console">Open the dashboard →</a>
        </div>
      </article>
    </MarketingShell>
  );
}
