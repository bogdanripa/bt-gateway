/**
 * Telegram link card. Lets the user generate a one-time link code, see
 * current link state, and unlink. The actual link-write happens inside
 * the bot webhook when the user sends `/start <code>` to the bot.
 */


import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

interface LinkStatus {
  linked: boolean;
  chatId?: number;
  username?: string;
  linkedAt?: string;
}

interface LinkCode {
  code: string;
  ttlMs: number;
  botUsername?: string;
  deepLink?: string | null;
}

export function TelegramCard({ botConfigured }: { botConfigured: boolean }) {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<LinkCode | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const s = await uiFetch<LinkStatus>('/api/ui/telegram');
      setStatus(s);
      if (s.linked) setPending(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (botConfigured) void refresh();
    else setLoading(false);
  }, [botConfigured]);

  async function startLink() {
    setBusy(true);
    setErr(null);
    try {
      const code = await uiFetch<LinkCode>('/api/ui/telegram/link-code', { method: 'POST' });
      setPending(code);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
      <h2>Chat link</h2>
      <p className="dim">
        Link your personal Telegram chat so the bot (configured above) can
        message you when BT Gateway signs in or when a sign-in fails. Routine
        refreshes every ~45 minutes do <em>not</em> trigger a message.
      </p>

      {!botConfigured && (
        <div className="notice">
          Configure your bot above before linking a chat.
        </div>
      )}

      {err && <div className="notice err">{err}</div>}

      {botConfigured && loading && <p className="dim">Loading…</p>}

      {botConfigured && !loading && status && !status.linked && !pending && (
        <>
          <p>Not linked.</p>
          <button onClick={() => { void startLink(); }} disabled={busy}>
            Generate link code
          </button>
        </>
      )}

      {!loading && pending && !status?.linked && (
        <div className="notice">
          <p>
            <strong>Send this to the bot to finish linking.</strong> The code is
            valid for 10 minutes; generate a new one if it expires.
          </p>
          <div className="mono-block" style={{ marginTop: '0.5rem' }}>
            /start {pending.code}
          </div>
          {pending.deepLink ? (
            <p style={{ marginTop: '0.5rem' }}>
              Tap to open the bot:{' '}
              <a href={pending.deepLink} target="_blank" rel="noreferrer">
                @{pending.botUsername}
              </a>
            </p>
          ) : (
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              (Bot username not configured on the server — DM your bot directly with the command above.)
            </p>
          )}
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <div style={{ flex: 1 }} />
            <div style={{ flex: 'none', display: 'flex', gap: '0.5rem' }}>
              <button className="ghost" onClick={() => setPending(null)}>Cancel</button>
              <button className="ghost" onClick={() => { void refresh(); }}>Check status</button>
            </div>
          </div>
        </div>
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
