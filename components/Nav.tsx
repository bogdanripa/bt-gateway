'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth/AuthProvider';

export function Nav() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();

  return (
    <div className="nav">
      <span className="nav-brand">bt-gateway</span>
      <Link href="/" className={pathname === '/' ? 'active' : ''}>Dashboard</Link>
      <Link href="/settings" className={pathname?.startsWith('/settings') ? 'active' : ''}>Settings</Link>
      <span className="spacer" />
      {user && <span className="user">{user.email}</span>}
      {user && (
        <button className="ghost" onClick={() => { void signOut(); }}>Sign out</button>
      )}
    </div>
  );
}
