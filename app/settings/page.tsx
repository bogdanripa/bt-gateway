'use client';

import { useEffect, useState } from 'react';
import { AuthGate } from '@/components/auth/AuthGate';
import { Nav } from '@/components/Nav';
import { CredsCard } from '@/components/settings/CredsCard';
import { ApiKeysCard } from '@/components/settings/ApiKeysCard';
import { TelegramBotCard } from '@/components/settings/TelegramBotCard';
import { TelegramCard } from '@/components/settings/TelegramCard';
import { uiFetch } from '@/lib/ui-client';

export default function SettingsPage() {
  // The chat-link card needs to know whether the user's bot is configured
  // (the link-code endpoint now rejects with CONFLICT if not). We fetch it
  // once at the page level and re-fetch whenever the bot card changes.
  const [botConfigured, setBotConfigured] = useState(false);

  async function refreshBotStatus() {
    try {
      const s = await uiFetch<{ configured: boolean }>('/api/ui/telegram/bot');
      setBotConfigured(!!s.configured);
    } catch {
      // Silent — on first sign-in the endpoint might return 401 briefly;
      // the TelegramBotCard will surface real errors.
    }
  }

  useEffect(() => { void refreshBotStatus(); }, []);

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
        <TelegramBotCard onChange={() => { void refreshBotStatus(); }} />
        <TelegramCard botConfigured={botConfigured} />
      </main>
    </AuthGate>
  );
}
