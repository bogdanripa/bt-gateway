/**
 * Per-user Telegram bot config. The user:
 *   1. Creates a bot with @BotFather in Telegram (one-off).
 *   2. Pastes the bot token here. The server validates it, registers the
 *      webhook with Telegram automatically, and stores the token encrypted.
 *
 * Once done, TelegramCard (the chat-link flow) unlocks.
 */


import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

interface WebhookInfo {
  url: string;
  matches: boolean;
  pendingUpdateCount: number;
  lastErrorDate?: string;
  lastErrorMessage?: string;
  ipAddress?: string;
}

interface BotStatus {
  configured: boolean;
  username?: string;
  webhookUrl?: string;
  webhookRegistered?: boolean;
  webhookInfo?: WebhookInfo | null;
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
        The webhook is registered automatically.
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
            <label>Updated</label>
            <span className="mono dim">{status.updatedAt}</span>
          </div>
          <WebhookDiagnostics status={status} onRetry={() => { void refresh(); }} busy={busy} />
          <div className="row" style={{ gap: '0.5rem' }}>
            <button className="ghost" onClick={() => setEditing(true)} disabled={busy}>
              Replace token
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

/**
 * Shows what Telegram thinks about our webhook so "nothing happens when I
 * /start" is diagnosable without ssh/logs:
 *   - URL mismatch → Telegram is delivering updates somewhere else.
 *   - last error → our endpoint returned non-2xx on Telegram's most recent
 *     attempt (URL typo, deploy down, wrong secret in path, etc.).
 *   - pending count → updates backed up because the webhook is failing.
 *   - empty/null info → Telegram refused to tell us (bad token).
 */
function WebhookDiagnostics({
  status,
  onRetry,
  busy,
}: {
  status: BotStatus;
  onRetry: () => void;
  busy: boolean;
}) {
  const info = status.webhookInfo;
  const expected = status.webhookUrl;

  if (info === null || info === undefined) {
    return (
      <div className="notice">
        <p>
          <strong>Webhook status unavailable.</strong> Couldn&apos;t reach Telegram to
          check what URL it has registered.
        </p>
      </div>
    );
  }

  const hasError = !!info.lastErrorMessage;
  const urlMismatch = !info.matches;
  const problem = urlMismatch || hasError;

  return (
    <div className={`notice ${problem ? 'err' : ''}`}>
      <div>
        <label>Webhook URL (Telegram)</label>
        <span className="mono" style={{ wordBreak: 'break-all' }}>
          {info.url || '(none set)'}
        </span>
      </div>
      {urlMismatch && expected && (
        <div style={{ marginTop: '0.5rem' }}>
          <label>Expected</label>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{expected}</span>
          <p className="dim" style={{ marginTop: '0.25rem' }}>
            Telegram has a different URL. Tap <strong>Replace token</strong> above and
            re-save to re-register this URL, or paste the same token to refresh.
          </p>
        </div>
      )}
      <div style={{ marginTop: '0.5rem' }}>
        <label>Pending updates</label>
        <span className="mono">{info.pendingUpdateCount}</span>
      </div>
      {hasError && (
        <div style={{ marginTop: '0.5rem' }}>
          <label>Last delivery error</label>
          <span className="mono">{info.lastErrorMessage}</span>
          {info.lastErrorDate && (
            <span className="mono dim" style={{ marginLeft: '0.5rem' }}>
              at {info.lastErrorDate}
            </span>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="ghost" onClick={onRetry} disabled={busy}>
          Refresh
        </button>
      </div>
    </div>
  );
}
