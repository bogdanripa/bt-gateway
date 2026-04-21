'use client';

import { useState } from 'react';
import { uiFetch } from '@/lib/ui-client';

type Mode = 'demo' | 'live';

interface CashData {
  availableAmount?: number;
  totalAmount?: number;
  currencyId?: string;
  [key: string]: unknown;
}

interface Holding {
  symbol?: string;
  quantity?: number;
  averagePrice?: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  [key: string]: unknown;
}

interface Snapshot {
  mode: Mode;
  cash: CashData;
  holdings: Holding[] | { items?: Holding[]; [key: string]: unknown };
}

function formatRon(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  return n.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' RON';
}

function formatPct(pnl: number | undefined, cost: number | undefined): string {
  if (!pnl || !cost || cost === 0) return '';
  const pct = (pnl / cost) * 100;
  return ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
}

export function AccountSnapshot() {
  const [mode, setMode] = useState<Mode>('demo');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const data = await uiFetch<Snapshot>(`/api/ui/account?mode=${mode}`);
      setSnapshot(data);
      setLoadedAt(new Date().toLocaleTimeString('ro-RO'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const holdings: Holding[] = snapshot
    ? Array.isArray(snapshot.holdings)
      ? snapshot.holdings
      : ((snapshot.holdings as { items?: Holding[] }).items ?? [])
    : [];

  const available = snapshot?.cash?.availableAmount;
  const total = snapshot?.cash?.totalAmount;

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>Live account data</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {(['demo', 'live'] as Mode[]).map(m => (
            <button
              key={m}
              className={mode === m ? '' : 'ghost'}
              onClick={() => { setMode(m); setSnapshot(null); setErr(null); }}
              disabled={loading}
              style={{ padding: '0.25rem 0.75rem' }}
            >
              {m}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => { void load(); }} disabled={loading}>
          {loading ? 'Loading…' : snapshot ? 'Refresh' : 'Get live data'}
        </button>
      </div>

      {loading && (
        <p className="dim" style={{ marginTop: '1rem' }}>
          Fetching from BT Trade… (first call may take up to 2 min if a fresh login is needed)
        </p>
      )}

      {err && <div className="notice err" style={{ marginTop: '1rem' }}>{err}</div>}

      {snapshot && !loading && (
        <div style={{ marginTop: '1rem' }}>
          <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div>
              <label>Available cash</label>
              <span className="mono" style={{ fontSize: '1.1rem' }}>{formatRon(available)}</span>
            </div>
            {total !== undefined && total !== available && (
              <div>
                <label>Total cash</label>
                <span className="mono">{formatRon(total)}</span>
              </div>
            )}
            <div>
              <label>Positions</label>
              <span className="mono">{holdings.length}</span>
            </div>
            {loadedAt && (
              <div style={{ marginLeft: 'auto' }}>
                <span className="dim" style={{ fontSize: '0.8rem' }}>as of {loadedAt}</span>
              </div>
            )}
          </div>

          {holdings.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem' }}>Symbol</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Qty</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Avg cost</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Current</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Market value</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h, i) => {
                  const pnl = h.unrealizedPnl as number | undefined;
                  const cost = h.averagePrice && h.quantity ? h.averagePrice * h.quantity : undefined;
                  const pnlPositive = pnl !== undefined && pnl > 0;
                  const pnlNegative = pnl !== undefined && pnl < 0;
                  return (
                    <tr key={h.symbol ?? i} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                      <td style={{ padding: '0.4rem 0.5rem' }}>
                        <span className="mono">{String(h.symbol ?? '—')}</span>
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {h.quantity ?? '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {h.averagePrice != null ? Number(h.averagePrice).toFixed(4) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {h.currentPrice != null ? Number(h.currentPrice).toFixed(4) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {formatRon(h.marketValue as number | undefined)}
                      </td>
                      <td style={{
                        textAlign: 'right', padding: '0.4rem 0.5rem',
                        color: pnlPositive ? 'var(--ok, #4caf50)' : pnlNegative ? 'var(--err, #f44336)' : undefined,
                      }} className="mono">
                        {pnl != null ? `${pnl >= 0 ? '+' : ''}${formatRon(pnl)}${formatPct(pnl, cost)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {holdings.length === 0 && (
            <p className="dim">No open positions in {mode} account.</p>
          )}
        </div>
      )}
    </div>
  );
}
