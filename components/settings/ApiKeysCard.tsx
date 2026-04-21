/**
 * API keys management. Lists existing keys (prefix/label/mode/status),
 * lets the user create new ones (showing the raw key exactly once), and
 * revoke any key.
 */

'use client';

import { useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

type Mode = 'demo' | 'live';

interface KeyRow {
  id: string;
  mode: Mode;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export function ApiKeysCard() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('demo');
  const [label, setLabel] = useState('');
  const [freshKey, setFreshKey] = useState<{ key: string; prefix: string; mode: Mode } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const { keys } = await uiFetch<{ keys: KeyRow[] }>('/api/ui/keys');
      setRows(keys);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const res = await uiFetch<{ key: string; prefix: string; mode: Mode }>('/api/ui/keys', {
        method: 'POST',
        body: JSON.stringify({ mode, label }),
      });
      setFreshKey({ key: res.key, prefix: res.prefix, mode: res.mode });
      setLabel('');
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this API key? Any client using it will start getting 401s.')) return;
    setBusy(true);
    setErr(null);
    try {
      await uiFetch(`/api/ui/keys/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="dim">
        Use these in your trading scripts: <span className="mono">Authorization: Bearer &lt;key&gt;</span>.
        Mode is fixed per key — a <span className="pill demo">demo</span> key can only hit
        demo endpoints; a <span className="pill live">live</span> key only live.
      </p>

      {err && <div className="notice err">{err}</div>}

      {freshKey && (
        <div className="notice ok">
          <strong>New {freshKey.mode} key created.</strong> Save this now — it will NOT be
          shown again.
          <pre className="mono-block" style={{ marginTop: '0.5rem' }}>{freshKey.key}</pre>
          <button className="ghost" onClick={() => setFreshKey(null)}>I&apos;ve saved it</button>
        </div>
      )}

      <div className="row" style={{ marginBottom: '1rem', alignItems: 'end' }}>
        <div>
          <label>Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="demo">demo</option>
            <option value="live">live</option>
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <label>Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. laptop, routine, backtester"
          />
        </div>
        <div style={{ flex: 'none' }}>
          <button onClick={() => { void create(); }} disabled={busy || !label.trim()}>
            Create key
          </button>
        </div>
      </div>

      {loading ? (
        <p className="dim">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="dim">No keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Mode</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td><span className={`pill ${r.mode}`}>{r.mode}</span></td>
                <td className="mono">{r.prefix}…</td>
                <td className="dim mono">{r.createdAt.slice(0, 10)}</td>
                <td className="dim mono">{r.lastUsedAt?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                <td>
                  {r.revokedAt
                    ? <span className="pill err">revoked</span>
                    : <span className="pill ok">active</span>}
                </td>
                <td>
                  {!r.revokedAt && (
                    <button className="ghost" onClick={() => { void revoke(r.id); }} disabled={busy}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
