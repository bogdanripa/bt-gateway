import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Privacy policy — bt-gateway',
  description:
    'How bt-gateway handles your data: what we store, where it lives (Firestore + Cloud KMS in europe-west3), who can see it, and how to delete it.',
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
          bt-gateway is a personal-scale service operated by Bogdan Ripa. This page
          explains what data the service collects, where it lives, and how long it stays.
        </p>

        <section aria-labelledby="what-we-store">
          <h2 id="what-we-store">What we store</h2>
          <ul>
            <li>
              <strong>Account identity.</strong> Your Google email and Firebase UID, captured
              when you sign in via Google. Used only to scope your data and verify your
              identity on subsequent requests.
            </li>
            <li>
              <strong>BT Trade credentials.</strong> Your BT username and password are
              envelope-encrypted with Cloud KMS before being written to Firestore. They are
              never logged, never returned over the API, and used only to authenticate to
              BT Trade on your behalf.
            </li>
            <li>
              <strong>Session tokens.</strong> Refresh tokens issued by BT Trade are stored
              encrypted alongside your credentials so the 30-minute refresh cycle can run
              without re-prompting for a one-time code.
            </li>
            <li>
              <strong>API keys.</strong> Only SHA-256 hashes of your generated API keys are
              stored. The raw key is shown once at creation and not recoverable.
            </li>
            <li>
              <strong>Audit log.</strong> Mutating actions (sign-ins, refresh failures, orders
              placed/cancelled, credential and key changes) are recorded with timestamps and
              actor info, scoped to your account.
            </li>
            <li>
              <strong>Telegram integration (optional).</strong> If you configure your own bot,
              its token is envelope-encrypted; the chat ID and webhook secret are stored in
              plaintext (they&apos;re not sensitive on their own).
            </li>
          </ul>
        </section>

        <section aria-labelledby="what-we-do-not-store">
          <h2 id="what-we-do-not-store">What we do not store</h2>
          <ul>
            <li>SMS messages, emails, or one-time passwords — they pass through ntfy and are consumed once.</li>
            <li>Order book / market data beyond what your own snapshots endpoint writes.</li>
            <li>Anything from other tenants in the same instance. Per-user isolation is enforced at the data-access layer.</li>
          </ul>
        </section>

        <section aria-labelledby="where">
          <h2 id="where">Where the data lives</h2>
          <p>
            bt-gateway runs on Google Cloud Run (region europe-west3) and stores all
            persistent data in Firestore in the same region. Secrets are managed by Google
            Cloud KMS. Application logs are sent to Google Cloud Logging with a default
            30-day retention.
          </p>
        </section>

        <section aria-labelledby="access">
          <h2 id="access">Who can see your data</h2>
          <p>
            Only you, after authenticating via Google sign-in or with one of your API keys.
            Internal staff access is limited to the operator (Bogdan Ripa) for debugging in
            response to support requests. No data is sold or shared with third parties.
            bt-gateway itself does, of course, forward requests to{' '}
            <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a> —
            that traffic is governed by Banca Transilvania&apos;s own terms.
          </p>
        </section>

        <section aria-labelledby="delete">
          <h2 id="delete">Deleting your data</h2>
          <p>
            You can wipe stored credentials and revoke all API keys from the dashboard. If
            you want a complete account deletion (Firestore documents + Firebase Auth user),
            email the operator and it will be done manually within 7 days.
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
