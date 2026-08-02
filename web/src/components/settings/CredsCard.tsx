/**
 * Per-mode credentials card (demo or live).
 *
 * Shows current status (set/not set) + redacted username + the ntfy topic
 * the user's phone shortcut must post SMS OTPs to. Lets the user submit
 * new creds or clear them.
 */


import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

type Mode = 'demo' | 'live';

interface CredsStatus {
  mode: Mode;
  set: boolean;
  usernameRedacted?: string;
  updatedAt?: string;
  ntfyTopic?: string | null;
  ntfyUrl?: string | null;
}

export function CredsCard({ mode }: { mode: Mode }) {
  const [status, setStatus] = useState<CredsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const s = await uiFetch<CredsStatus>(`/api/ui/creds/${mode}`);
      setStatus(s);
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [mode]);

  async function submit() {
    setBusy(true);
    setMsg(null);
    try {
      await uiFetch(`/api/ui/creds/${mode}`, {
        method: 'PUT',
        body: JSON.stringify({ username, password }),
      });
      setEditing(false);
      setUsername('');
      setPassword('');
      setMsg({ kind: 'ok', text: `${mode} credentials saved.` });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirm(`Clear ${mode} credentials? The saved session will also be discarded.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await uiFetch(`/api/ui/creds/${mode}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: `${mode} credentials cleared.` });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>
          BT Trade — <span className={`pill ${mode}`}>{mode}</span>
        </h2>
        <div style={{ flex: 'none' }}>
          {status?.set && !editing && (
            <button className="ghost" onClick={() => setEditing(true)} disabled={busy}>
              Update
            </button>
          )}
        </div>
      </div>

      {msg && <div className={`notice ${msg.kind}`}>{msg.text}</div>}

      {loading && <p className="dim">Loading…</p>}

      {!loading && !editing && status && !status.set && (
        <>
          <p className="dim">No {mode} credentials set yet.</p>
          <button onClick={() => setEditing(true)}>Add credentials</button>
        </>
      )}

      {!loading && !editing && status?.set && (
        <div className="stack">
          <div>
            <label>Username</label>
            <span className="mono">{status.usernameRedacted ?? '—'}</span>
          </div>
          <div>
            <label>Last updated</label>
            <span className="mono dim">{status.updatedAt}</span>
          </div>
          {status.ntfyUrl && (
            <div>
              <label>ntfy topic for SMS OTP forwarding</label>
              <div className="mono" style={{ wordBreak: 'break-all' }}>
                <a href={status.ntfyUrl} target="_blank" rel="noreferrer">{status.ntfyUrl}</a>
              </div>
              <small className="muted">
                Point your phone&apos;s SMS-forwarding Shortcut / Tasker / Automate flow
                at this URL. The server waits on it for 2FA codes during sign-in.
              </small>
            </div>
          )}
          <div>
            <button className="danger" onClick={() => { void clear(); }} disabled={busy}>
              Clear credentials
            </button>
          </div>
        </div>
      )}

      {!loading && editing && (
        <div className="stack">
          <div>
            <label>BT Trade username (for {mode})</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              placeholder="bt trade login"
            />
          </div>
          <div>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <small className="muted">
            Stored encrypted via AES-256-GCM envelope encryption. Never logged. Used
            only to establish a BT Trade session for this account.
          </small>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <div style={{ flex: 1 }} />
            <div style={{ flex: 'none', display: 'flex', gap: '0.5rem' }}>
              <button
                className="ghost"
                onClick={() => { setEditing(false); setUsername(''); setPassword(''); }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                onClick={() => { void submit(); }}
                disabled={busy || !username || !password}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
