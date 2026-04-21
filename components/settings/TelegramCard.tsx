/**
 * Telegram link card. Tells the user how to link (message @<bot> with
 * /start <linkCode>) and exposes an unlink button when already linked.
 *
 * M3 shows instructions only — the link webhook itself lands in M4. The
 * settings page is already useful without linking: notifications are
 * opt-in and the rest of the app works without them.
 */

'use client';

import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

interface LinkStatus {
  linked: boolean;
  chatId?: number;
  username?: string;
  linkedAt?: string;
}

export function TelegramCard() {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const s = await uiFetch<LinkStatus>('/api/ui/telegram');
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function unlink() {
    if (!confirm('Unlink Telegram? You will stop receiving sign-in alerts.')) return;
    setBusy(true);
    setErr(null);
    try {
      await uiFetch('/api/ui/telegram', { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Telegram alerts</h2>
      <p className="dim">
        Optional. Get a Telegram message only when bt-gateway signs in or when a sign-in
        fails. Routine refreshes every ~45 minutes do <em>not</em> trigger a message.
      </p>

      {err && <div className="notice err">{err}</div>}

      {loading && <p className="dim">Loading…</p>}

      {!loading && status && !status.linked && (
        <>
          <p>
            Not linked. Linking goes live with the keep-alive cron (M4). When it&apos;s on,
            you&apos;ll open <span className="mono">@bt_gateway_bot</span> and send{' '}
            <span className="mono">/start &lt;your-link-code&gt;</span>.
          </p>
        </>
      )}

      {!loading && status?.linked && (
        <div className="stack">
          <div>
            <label>Linked as</label>
            <span className="mono">
              {status.username ? `@${status.username}` : `chat ${status.chatId}`}
            </span>
          </div>
          <div>
            <label>Since</label>
            <span className="mono dim">{status.linkedAt}</span>
          </div>
          <div>
            <button className="danger" onClick={() => { void unlink(); }} disabled={busy}>
              Unlink
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
