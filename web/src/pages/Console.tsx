
import { AuthGate } from '@/components/auth/AuthGate';
import { Nav } from '@/components/Nav';
import { AuditFeed } from '@/components/AuditFeed';
import { AccountSnapshot } from '@/components/AccountSnapshot';
import { SessionStatus } from '@/components/SessionStatus';

export function HomePage() {
  return (
    <AuthGate>
      <Nav />
      <main className="container">
        <h1>Dashboard</h1>
        <AccountSnapshot />
        <div style={{ marginTop: '1.5rem' }}>
          <SessionStatus />
        </div>
        <h2 style={{ marginTop: '2rem' }}>Audit log</h2>
        <p className="dim">
          Every action BT Gateway takes on your behalf — sign-ins, refreshes, orders,
          credential and key changes — is logged below. Read-only operations (cash,
          holdings, quotes) are not audited here.
        </p>
        <AuditFeed />
      </main>
    </AuthGate>
  );
}
