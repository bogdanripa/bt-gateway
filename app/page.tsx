'use client';

import { AuthGate } from '@/components/auth/AuthGate';
import { Nav } from '@/components/Nav';
import { AuditFeed } from '@/components/AuditFeed';

export default function HomePage() {
  return (
    <AuthGate>
      <Nav />
      <main className="container">
        <h1>Dashboard</h1>
        <p className="dim">
          Everything bt-gateway does on your behalf — sign-ins, refreshes, orders,
          credential and key changes — is logged below. Read operations (cash,
          holdings, quotes) are not audited here; they live in Cloud Logging.
        </p>
        <AuditFeed />
      </main>
    </AuthGate>
  );
}
