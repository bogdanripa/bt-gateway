/**
 * API keys management. Lists existing keys (prefix/label/mode/status),
 * lets the user create new ones (showing the raw key exactly once), revoke
 * any key, and edit per-key filters (markets / currencies / stocks with
 * include + exclude lists).
 */

'use client';

import { Fragment, useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';
import { useMode, type Mode } from '../mode/ModeProvider';
import { EMPTY_FILTERS, FilterEditor, type Filters } from './FilterEditor';

interface KeyRow {
  id: string;
  mode: Mode;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  filters?: Filters;
}

function cloneFilters(f: Filters | undefined): Filters {
  if (!f) return { markets: { include: [], exclude: [] }, currencies: { include: [], exclude: [] }, stocks: { include: [], exclude: [] } };
  return {
    markets: { include: [...f.markets.include], exclude: [...f.markets.exclude] },
    currencies: { include: [...f.currencies.include], exclude: [...f.currencies.exclude] },
    stocks: { include: [...f.stocks.include], exclude: [...f.stocks.exclude] },
  };
}

function hasAnyFilter(f: Filters | undefined): boolean {
  if (!f) return false;
  return (
    f.markets.include.length + f.markets.exclude.length +
    f.currencies.include.length + f.currencies.exclude.length +
    f.stocks.include.length + f.stocks.exclude.length
  ) > 0;
}

function summarizeFilters(f: Filters | undefined): string {
  if (!f || !hasAnyFilter(f)) return 'unrestricted';
  const parts: string[] = [];
  const axes: [string, keyof Filters][] = [['mkt', 'markets'], ['ccy', 'currencies'], ['sym', 'stocks']];
  for (const [short, key] of axes) {
    const a = f[key];
    if (a.include.length) parts.push(`${short}∈[${a.include.slice(0, 3).join(',')}${a.include.length > 3 ? '…' : ''}]`);
    if (a.exclude.length) parts.push(`${short}∉[${a.exclude.slice(0, 3).join(',')}${a.exclude.length > 3 ? '…' : ''}]`);
  }
  return parts.join(' ');
}

export function ApiKeysCard() {
  const { mode } = useMode();
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [createFilters, setCreateFilters] = useState<Filters>(() => cloneFilters(EMPTY_FILTERS));
  const [showCreateFilters, setShowCreateFilters] = useState(false);
  const [freshKey, setFreshKey] = useState<{ key: string; prefix: string; mode: Mode } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingFilters, setEditingFilters] = useState<Filters>(() => cloneFilters(EMPTY_FILTERS));
  const [editingMode, setEditingMode] = useState<Mode>('demo');

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
        body: JSON.stringify({
          mode,
          label,
          ...(hasAnyFilter(createFilters) ? { filters: createFilters } : {}),
        }),
      });
      setFreshKey({ key: res.key, prefix: res.prefix, mode: res.mode });
      setLabel('');
      setCreateFilters(cloneFilters(EMPTY_FILTERS));
      setShowCreateFilters(false);
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

  function startEdit(row: KeyRow) {
    setEditingId(row.id);
    setEditingMode(row.mode);
    setEditingFilters(cloneFilters(row.filters));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingFilters(cloneFilters(EMPTY_FILTERS));
  }

  async function saveEdit() {
    if (!editingId) return;
    setBusy(true);
    setErr(null);
    try {
      await uiFetch(`/api/ui/keys/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({ filters: editingFilters }),
      });
      setEditingId(null);
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
        Use in <span className="mono">Authorization: Bearer &lt;key&gt;</span>. Optional
        filters restrict what each key can see or act on — by market, currency, or
        individual stock symbols.
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

      <div className="row" style={{ marginBottom: '0.5rem', alignItems: 'end' }}>
        <div style={{ flex: 2 }}>
          <label>New key label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. laptop, routine, backtester"
          />
        </div>
        <div style={{ flex: 'none' }}>
          <button
            className="ghost"
            type="button"
            onClick={() => setShowCreateFilters((v) => !v)}
          >
            {showCreateFilters ? 'Hide filters' : hasAnyFilter(createFilters) ? 'Edit filters' : 'Add filters'}
          </button>
        </div>
        <div style={{ flex: 'none' }}>
          <button onClick={() => { void create(); }} disabled={busy || !label.trim()}>
            Create key
          </button>
        </div>
      </div>

      {showCreateFilters && (
        <div style={{ marginBottom: '1rem' }}>
          <FilterEditor
            mode={mode}
            filters={createFilters}
            onChange={setCreateFilters}
          />
        </div>
      )}

      {(() => {
        const visible = rows.filter((r) => r.mode === mode);
        if (loading) return <p className="dim">Loading…</p>;
        if (rows.length === 0) return <p className="dim">No keys yet.</p>;
        if (visible.length === 0) {
          return (
            <p className="dim">
              No <span className={`pill ${mode}`}>{mode}</span> keys yet — create one
              above, or switch mode in the header to see your other keys.
            </p>
          );
        }
        return (
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Prefix</th>
              <th>Filters</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>{r.label}</td>
                  <td className="mono">{r.prefix}…</td>
                  <td className="mono dim" style={{ fontSize: '0.8rem', maxWidth: 260 }}>
                    {summarizeFilters(r.filters)}
                  </td>
                  <td className="dim mono">{r.createdAt.slice(0, 10)}</td>
                  <td className="dim mono">{r.lastUsedAt?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                  <td>
                    {r.revokedAt
                      ? <span className="pill err">revoked</span>
                      : <span className="pill ok">active</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!r.revokedAt && (
                      <>
                        <button
                          className="ghost"
                          onClick={() => (editingId === r.id ? cancelEdit() : startEdit(r))}
                          disabled={busy}
                          style={{ marginRight: '0.25rem' }}
                        >
                          {editingId === r.id ? 'Close' : 'Filters'}
                        </button>
                        <button className="ghost" onClick={() => { void revoke(r.id); }} disabled={busy}>
                          Revoke
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {editingId === r.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--card-inner-bg, rgba(128,128,128,0.05))' }}>
                      <FilterEditor
                        mode={editingMode}
                        filters={editingFilters}
                        onChange={setEditingFilters}
                        embedded
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                        <button className="ghost" onClick={cancelEdit} disabled={busy}>Cancel</button>
                        <button onClick={() => { void saveEdit(); }} disabled={busy}>Save filters</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        );
      })()}
    </div>
  );
}
