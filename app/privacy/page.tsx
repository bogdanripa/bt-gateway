import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Privacy policy — BT Gateway',
  description:
    'How BT Gateway handles your data: what we store, where it lives (Google Cloud, europe-west3), who can see it, and how to delete it.',
  alternates: { canonical: `${SITE_URL}/privacy` },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <MarketingShell>
      <article>
        <header>
          <h1>Privacy policy</h1>
          <p className="dim">Last updated: 2026-05-28</p>
        </header>

        <p>
          BT Gateway is a personal-scale service operated by Bogdan Ripa. This page
          explains what data the service collects, where it lives, and how long it stays.
        </p>

        <section aria-labelledby="what-we-store">
          <h2 id="what-we-store">What we store</h2>
          <ul>
            <li>
              <strong>Account identity.</strong> Your Google email and a Google-issued user
              ID, captured when you sign in via Google. Used only to scope your data and
              verify your identity on subsequent requests.
            </li>
            <li>
              <strong>BT Trade credentials.</strong> Your BT username and password are
              encrypted with Google Cloud KMS before being stored. They are never logged,
              never returned over the API, and used only to sign in to BT Trade on your
              behalf.
            </li>
            <li>
              <strong>Session data.</strong> The tokens BT issues after a successful sign-in
              are stored encrypted alongside your credentials, so the connection can be
              kept alive without re-prompting for a one-time code on every page load.
            </li>
            <li>
              <strong>API keys.</strong> Only one-way hashes (SHA-256) of your generated
              API keys are stored. The raw key is shown once at creation and is not
              recoverable.
            </li>
            <li>
              <strong>Audit log.</strong> Actions that change something (sign-ins, orders
              placed or cancelled, credential and key changes) are recorded with
              timestamps and who triggered them, scoped to your account.
            </li>
            <li>
              <strong>Telegram integration (optional).</strong> If you set up your own
              Telegram bot for alerts, its token is encrypted; the chat ID and webhook
              path are stored as plain values (they&apos;re not sensitive on their own).
            </li>
          </ul>
        </section>

        <section aria-labelledby="what-we-do-not-store">
          <h2 id="what-we-do-not-store">What we do not store</h2>
          <ul>
            <li>SMS messages, emails, or one-time codes — they pass through the forwarder and are consumed once.</li>
            <li>Market data beyond what your own scripts choose to save through the snapshots endpoint.</li>
            <li>Anything from other users. Your data is isolated from theirs and we never see across accounts.</li>
          </ul>
        </section>

        <section aria-labelledby="where">
          <h2 id="where">Where the data lives</h2>
          <p>
            BT Gateway runs on Google Cloud (region europe-west3, in Frankfurt) and
            stores all persistent data in the same region. Secrets are managed by Google
            Cloud KMS. Diagnostic logs are kept for 30 days by default.
          </p>
        </section>

        <section aria-labelledby="access">
          <h2 id="access">Who can see your data</h2>
          <p>
            Only you, after signing in with Google or with one of your API keys. Operator
            access is limited to Bogdan Ripa for debugging in response to support
            requests. No data is sold or shared with third parties. BT Gateway does, of
            course, forward requests to{' '}
            <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a> —
            that traffic is governed by Banca Transilvania&apos;s own terms.
          </p>
        </section>

        <section aria-labelledby="delete">
          <h2 id="delete">Deleting your data</h2>
          <p>
            You can wipe your stored credentials and revoke all API keys from the
            dashboard. For a complete account deletion (everything we hold about you),
            email the operator &mdash; it will be done manually within 7 days.
          </p>
        </section>

        <p className="dim" style={{ marginTop: '2rem' }}>
          Questions? See <a href="/terms">Terms</a> or open an issue on{' '}
          <a href="https://github.com/bogdanripa/bt-gateway" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </article>
    </MarketingShell>
  );
}
