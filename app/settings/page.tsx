'use client';

import { AuthGate } from '@/components/auth/AuthGate';
import { Nav } from '@/components/Nav';
import { CredsCard } from '@/components/settings/CredsCard';
import { ApiKeysCard } from '@/components/settings/ApiKeysCard';
import { TelegramCard } from '@/components/settings/TelegramCard';

export default function SettingsPage() {
  return (
    <AuthGate>
      <Nav />
      <main className="container">
        <h1>Settings</h1>
        <h3>Credentials</h3>
        <CredsCard mode="demo" />
        <CredsCard mode="live" />
        <h3 style={{ marginTop: '2rem' }}>Access</h3>
        <ApiKeysCard />
        <h3 style={{ marginTop: '2rem' }}>Notifications</h3>
        <TelegramCard />
      </main>
    </AuthGate>
  );
}
