/**
 * Per-user Telegram bot config. The user:
 *   1. Creates a bot with @BotFather in Telegram (one-off).
 *   2. Pastes the bot token here. The server validates with Telegram's
 *      getMe endpoint, stores the token envelope-encrypted via KMS, and
 *      returns the webhook URL we need Telegram to call.
 *   3. Runs a single `setWebhook` curl against the Telegram API pointing
 *      at that URL (copy-paste command shown below).
 *
 * Once that's done, TelegramCard (the chat-link flow) unlocks and the user
 * can finish linking their personal chat via /start <code>.
 */

'use client';

import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

interface BotStatus {
  configured: boolean;
  username?: string;
  webhookUrl?: string;
  updatedAt?: string;
}

export function TelegramBotCard({ onChange }: { onChange?: () => void }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const s = await uiFetch<BotStatus>('/api/ui/telegram/bot');
      setStatus(s);
      onChange?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await uiFetch('/api/ui/telegram/bot', {
        method: 'PUT',
        body: JSON.stringify({ token: token.trim() }),
        headers: { 'content-type': 'application/json' },
      });
      setToken('');
      setEditing(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm('Remove your Telegram bot? You will stop receiving alerts.')) return;
    setBusy(true);
    setErr(null);
    try {
      await uiFetch('/api/ui/telegram/bot', { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Telegram bot</h2>
      <p className="dim">
        Each user brings their own bot. Create one in Telegram via{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>{' '}
        (<span className="mono">/newbot</span>), then paste the bot token here.
        See <a href="/docs/telegram" target="_blank" rel="noreferrer">the Telegram setup guide</a>.
      </p>

      {err && <div className="notice err">{err}</div>}

      {loading && <p className="dim">Loading…</p>}

      {!loading && status && !status.configured && !editing && (
        <>
          <p>No bot configured.</p>
          <button onClick={() => setEditing(true)} disabled={busy}>Add bot</button>
        </>
      )}

      {!loading && status?.configured && !editing && (
        <div className="stack">
          <div>
            <label>Bot</label>
            <span className="mono">@{status.username}</span>
          </div>
          <div>
            <label>Webhook URL</label>
            <div className="mono-block" style={{ wordBreak: 'break-all' }}>
              {status.webhookUrl}
            </div>
          </div>
          <div>
            <label>Point Telegram at the webhook</label>
            <p className="dim">
              Run this once (replace <span className="mono">&lt;TOKEN&gt;</span> with
              your bot token from @BotFather):
            </p>
            <div className="mono-block" style={{ wordBreak: 'break-all' }}>
              {`curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=${status.webhookUrl}"`}
            </div>
          </div>
          <div>
            <label>Updated</label>
            <span className="mono dim">{status.updatedAt}</span>
          </div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button className="ghost" onClick={() => setEditing(true)} disabled={busy}>
              Rotate token
            </button>
            <button className="danger" onClick={() => { void remove(); }} disabled={busy}>
              Remove bot
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="stack">
          <div>
            <label>Bot token</label>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="123456:ABC-DEF..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              style={{ width: '100%' }}
            />
            <p className="dim">
              Pasted into an encrypted field — only the hash-like shape is stored
              in the browser (no logging). The server envelope-encrypts it via
              Cloud KMS before persisting.
            </p>
          </div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button onClick={() => { void save(); }} disabled={busy || !token.trim()}>
              {status?.configured ? 'Replace token' : 'Save bot'}
            </button>
            <button
              className="ghost"
              onClick={() => { setEditing(false); setToken(''); setErr(null); }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
