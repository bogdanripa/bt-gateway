import type { Metadata } from 'next';
import { MarketingShell } from '@/components/MarketingShell';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export const metadata: Metadata = {
  title: 'Terms of use — bt-gateway',
  description:
    'Terms of use for bt-gateway: not affiliated with Banca Transilvania, no warranty, no financial advice, acceptable use, and account termination.',
  alternates: { canonical: `${SITE_URL}/terms` },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <MarketingShell>
      <article>
        <header>
          <h1>Terms of use</h1>
          <p className="dim">Last updated: 2026-05-28</p>
        </header>

        <p>
          bt-gateway is an unofficial, personal-scale tool operated by Bogdan Ripa. By
          using it you agree to the following.
        </p>

        <section aria-labelledby="not-affiliated">
          <h2 id="not-affiliated">Not affiliated with Banca Transilvania</h2>
          <p>
            bt-gateway is <strong>not</strong> a product of Banca Transilvania, BT Capital
            Partners, or any related entity. It proxies authenticated calls to{' '}
            <a href="https://bt-trade.ro" target="_blank" rel="noreferrer">bt-trade.ro</a>{' '}
            on your behalf, using credentials you supply. Your use of bt-trade.ro is still
            governed by their own terms, and you are responsible for staying within them.
          </p>
        </section>

        <section aria-labelledby="your-orders">
          <h2 id="your-orders">You own your orders</h2>
          <p>
            Any order placed via bt-gateway — through the REST API, the MCP connector, or
            the dashboard — is your own order. bt-gateway does not preview, screen, or
            validate orders beyond surface checks (filter allowlists, price/quantity
            sanity). You are solely responsible for what gets sent to BT.
          </p>
        </section>

        <section aria-labelledby="no-advice">
          <h2 id="no-advice">No financial advice</h2>
          <p>
            bt-gateway does not offer trading recommendations. The MCP connector lets an AI
            client read your account and place orders that it composes; the resulting orders
            are <em>your</em> orders, and the AI&apos;s suggestions are not investment
            advice. If you wire an autonomous agent to <code>place_order</code>, the
            resulting trades are on you.
          </p>
        </section>

        <section aria-labelledby="no-warranty">
          <h2 id="no-warranty">No warranty, no liability</h2>
          <p>
            The service is provided as-is. The operator makes no warranty that it will be
            available, accurate, or fit for any purpose, and is not liable for losses,
            missed trades, incorrect fills, or any damages arising from your use of it. If
            bt-gateway is down, BT Trade is down, the refresh window lapses, your phone
            misses an OTP, the SMS gets delayed, or any of a hundred other failure modes
            bite — that&apos;s the trade-off of running a small unofficial bridge.
          </p>
        </section>

        <section aria-labelledby="acceptable-use">
          <h2 id="acceptable-use">Acceptable use</h2>
          <ul>
            <li>Only use your own BT Trade credentials. Do not connect another person&apos;s account.</li>
            <li>Do not abuse the service with excessive request volume — rate limits exist and may tighten without notice.</li>
            <li>Do not attempt to circumvent tenant isolation, exfiltrate other users&apos; data, or probe for vulnerabilities. Report any security issues privately.</li>
          </ul>
        </section>

        <section aria-labelledby="termination">
          <h2 id="termination">Account termination</h2>
          <p>
            The operator may suspend or remove an account at any time for abuse, legal
            compliance, or because the service is shutting down. You can leave at any time
            from your dashboard (revoke keys, clear credentials), or by emailing the
            operator for a full data wipe.
          </p>
        </section>

        <p className="dim" style={{ marginTop: '2rem' }}>
          See <a href="/privacy">Privacy</a> for what data is stored and how long.
        </p>
      </article>
    </MarketingShell>
  );
}
