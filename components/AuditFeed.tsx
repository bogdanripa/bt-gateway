/**
 * Audit feed. Shows the mutating-event stream for the tenant, with optional
 * filters. Routine refresh.* events are hidden by default to keep the focus
 * on trading activity; toggle them on from the filter row.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

interface EventRow {
  type: string;
  actor: string;
  mode?: 'demo' | 'live';
  status: 'ok' | 'err';
  detail?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  ts: string;
}

const ROUTINE_TYPES = new Set(['refresh.success', 'refresh.failure', 'signin.restored']);

export function AuditFeed() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showRefresh, setShowRefresh] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const { events } = await uiFetch<{ events: EventRow[] }>('/api/ui/events?limit=200');
      setRows(events);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(
    () => showRefresh ? rows : rows.filter((r) => !ROUTINE_TYPES.has(r.type)),
    [rows, showRefresh],
  );

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>Audit</h2>
        <div style={{ flex: 'none', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={showRefresh}
              onChange={(e) => setShowRefresh(e.target.checked)}
            />
            <span className="dim">Show routine refreshes</span>
          </label>
          <button className="ghost" onClick={() => { void refresh(); }}>Reload</button>
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}

      {loading ? (
        <p className="dim">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="dim">
          {rows.length === 0
            ? 'No events yet. Activity from your trading scripts and UI actions will appear here.'
            : `${rows.length} routine refresh event${rows.length === 1 ? '' : 's'} hidden — tick "Show routine refreshes" above to see them.`}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Actor</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.ts}-${i}`}>
                <td className="mono dim">{r.ts.replace('T', ' ').slice(0, 19)}</td>
                <td className="mono">{r.type}</td>
                <td className="mono dim">{r.actor}</td>
                <td>{r.mode ? <span className={`pill ${r.mode}`}>{r.mode}</span> : ''}</td>
                <td>
                  <span className={`pill ${r.status === 'ok' ? 'ok' : 'err'}`}>{r.status}</span>
                </td>
                <td className="mono dim" style={{ maxWidth: 360 }}>
                  {r.error
                    ? `${r.error.code ?? 'err'}: ${r.error.message ?? ''}`
                    : r.detail ? compactDetail(r.detail) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function compactDetail(d: Record<string, unknown>): string {
  // Prefer a few common keys before falling back to JSON.
  const bits: string[] = [];
  if (typeof d.symbol === 'string') bits.push(d.symbol);
  if (typeof d.side === 'string') bits.push(String(d.side));
  if (typeof d.quantity === 'number') bits.push(`qty=${d.quantity}`);
  if (typeof d.price === 'number') bits.push(`@${d.price}`);
  if (typeof d.label === 'string') bits.push(`label=${d.label}`);
  if (typeof d.prefix === 'string') bits.push(d.prefix);
  if (bits.length) return bits.join(' ');
  // Otherwise short-stringify.
  const s = JSON.stringify(d);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}
