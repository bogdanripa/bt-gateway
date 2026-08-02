import { useEffect, useMemo, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';
import { useMode, type Mode } from './mode/ModeProvider';

interface MoneyValue {
  formatted?: string;
  amount?: number;
  currency?: string;
  direction?: string;
  [key: string]: unknown;
}

interface BalanceEntry {
  title?: string;
  type?: string;
  value?: MoneyValue;
  highlightText?: string;
  highlightBackground?: string;
  balanceId?: string;
  [key: string]: unknown;
}

interface Holding {
  symbol?: string;
  /** Any of these may carry a human-readable instrument name. */
  fullName?: string;
  name?: string;
  description?: string;
  market?: string;
  currency?: string;
  quantity?: number;
  averagePrice?: number;
  currentPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  [key: string]: unknown;
}

interface Snapshot {
  mode: Mode;
  currencyId?: number;
  cash: BalanceEntry[] | null;
  cashError?: string | null;
  holdings: Holding[] | { items?: Holding[]; [key: string]: unknown } | null;
  holdingsError?: string | null;
}

const N2 = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
const N4 = { minimumFractionDigits: 4, maximumFractionDigits: 4 };
const nfRon = (n: number): string => n.toLocaleString('ro-RO', N2);
const nfQty = (n: number): string => n.toLocaleString('ro-RO', { maximumFractionDigits: 4 });
const nfPrice = (n: number): string => n.toLocaleString('ro-RO', N4);

function formatMoney(n: number | undefined | null, currency = 'RON'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${nfRon(n)} ${currency}`;
}

function nameOf(h: Holding): string | undefined {
  const v = h.fullName ?? h.name ?? h.description;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Format a P&L amount + optional cost-basis for the holdings table. Returns
 * both the display text and the CSS color — used identically on each row and
 * on the footer total.
 */
function formatPnl(pnl: number | undefined, cost: number | undefined, ccy = 'RON'): {
  text: string;
  color: string | undefined;
} {
  if (pnl == null || !Number.isFinite(pnl)) return { text: '—', color: undefined };
  const sign = pnl >= 0 ? '+' : '';
  const pct = cost && cost !== 0
    ? ` (${sign}${((pnl / cost) * 100).toFixed(2)}%)`
    : '';
  const color = pnl > 0 ? 'var(--ok, #4caf50)'
    : pnl < 0 ? 'var(--err, #f44336)'
    : undefined;
  return { text: `${sign}${formatMoney(pnl, ccy)}${pct}`, color };
}

export function AccountSnapshot() {
  const { mode } = useMode();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  useEffect(() => {
    setSnapshot(null);
    setErr(null);
    setLoadedAt(null);
  }, [mode]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const data = await uiFetch<Snapshot>(`/api/ui/account?mode=${mode}`);
      setSnapshot(data);
      setLoadedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const holdingsRaw: Holding[] = snapshot && snapshot.holdings
    ? Array.isArray(snapshot.holdings)
      ? snapshot.holdings
      : ((snapshot.holdings as { items?: Holding[] }).items ?? [])
    : [];

  // Sort by market value desc; unknown values sink to the bottom.
  const holdings = useMemo(
    () => [...holdingsRaw].sort((a, b) => (b.marketValue ?? -Infinity) - (a.marketValue ?? -Infinity)),
    [holdingsRaw],
  );

  const totalMv = useMemo(
    () => holdings.reduce((acc, h) => acc + (typeof h.marketValue === 'number' ? h.marketValue : 0), 0),
    [holdings],
  );
  const totalPnl = useMemo(
    () => holdings.reduce((acc, h) => acc + (typeof h.unrealizedPnl === 'number' ? h.unrealizedPnl : 0), 0),
    [holdings],
  );
  const totalCost = useMemo(
    () => holdings.reduce((acc, h) => {
      if (typeof h.averagePrice === 'number' && typeof h.quantity === 'number') {
        return acc + h.averagePrice * h.quantity;
      }
      return acc;
    }, 0),
    [holdings],
  );

  const cashEntries: BalanceEntry[] = Array.isArray(snapshot?.cash) ? snapshot!.cash! : [];

  function formatEntry(v: MoneyValue | undefined): string {
    if (!v) return '—';
    if (v.formatted) return v.formatted;
    if (typeof v.amount === 'number') {
      const n = v.amount.toLocaleString('ro-RO', N2);
      return v.currency ? `${n} ${v.currency}` : n;
    }
    return '—';
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>
          Account data — <span className={`pill ${mode}`}>{mode}</span>
        </h2>
        <div style={{ flex: 1 }} />
        <button onClick={() => { void load(); }} disabled={loading}>
          {loading ? 'Loading…' : snapshot ? 'Refresh' : 'Fetch from BT'}
        </button>
      </div>

      {loading && (
        <p className="dim" style={{ marginTop: '1rem' }}>
          Fetching from BT Trade… (first call may take up to 2 min if a fresh login is needed)
        </p>
      )}

      {err && <div className="notice err" style={{ marginTop: '1rem' }}>{err}</div>}

      {snapshot && !loading && (snapshot.cashError || snapshot.holdingsError) && (
        <div className="notice err" style={{ marginTop: '1rem' }}>
          {snapshot.cashError && <div>Cash: {snapshot.cashError}</div>}
          {snapshot.holdingsError && <div>Holdings: {snapshot.holdingsError}</div>}
        </div>
      )}

      {snapshot && !loading && (
        <div style={{ marginTop: '1rem' }}>
          <div className="row" style={{ gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem', alignItems: 'flex-start' }}>
            {cashEntries.length > 0 ? (
              cashEntries.map((e, i) => (
                <div key={e.balanceId ?? i}>
                  <label>{e.title ?? e.type ?? 'Balance'}</label>
                  <span className="mono" style={{ fontSize: i === 0 ? '1.1rem' : undefined }}>
                    {formatEntry(e.value)}
                  </span>
                </div>
              ))
            ) : (
              <div>
                <label>Cash</label>
                <span className="mono">—</span>
              </div>
            )}
            <div>
              <label>Positions</label>
              <span className="mono">{holdings.length}</span>
            </div>
            <div>
              <label>Total value</label>
              <span className="mono">{formatMoney(totalMv || null)}</span>
            </div>
            {totalPnl !== 0 && totalCost !== 0 && (() => {
              const display = formatPnl(totalPnl, totalCost);
              return (
                <div>
                  <label>Unrealized P&amp;L</label>
                  <span className="mono" style={{ color: display.color }}>
                    {display.text}
                  </span>
                </div>
              );
            })()}
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
                  <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem' }}>Market</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Qty</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Avg cost</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Current</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Market value</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>Weight</th>
                  <th style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }}>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h, i) => {
                  const pnl = typeof h.unrealizedPnl === 'number' ? h.unrealizedPnl : undefined;
                  const cost = typeof h.averagePrice === 'number' && typeof h.quantity === 'number'
                    ? h.averagePrice * h.quantity : undefined;
                  const mv = typeof h.marketValue === 'number' ? h.marketValue : undefined;
                  const weight = mv !== undefined && totalMv > 0 ? (mv / totalMv) * 100 : undefined;
                  const ccy = typeof h.currency === 'string' && h.currency ? h.currency : 'RON';
                  const pnlDisplay = formatPnl(pnl, cost, ccy);
                  const longName = nameOf(h);
                  return (
                    <tr key={`${h.symbol ?? 'row'}-${i}`} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                      <td style={{ padding: '0.4rem 0.5rem' }}>
                        <div className="mono">{String(h.symbol ?? '—')}</div>
                        {longName && (
                          <div className="dim" style={{ fontSize: '0.75rem' }}>{longName}</div>
                        )}
                      </td>
                      <td style={{ padding: '0.4rem 0.5rem' }} className="mono dim">
                        {typeof h.market === 'string' && h.market ? h.market : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {typeof h.quantity === 'number' ? nfQty(h.quantity) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {typeof h.averagePrice === 'number' ? nfPrice(h.averagePrice) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {typeof h.currentPrice === 'number' ? nfPrice(h.currentPrice) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono">
                        {formatMoney(mv, ccy)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem' }} className="mono dim">
                        {weight !== undefined ? `${weight.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem 0.5rem', color: pnlDisplay.color }} className="mono">
                        {pnlDisplay.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {(totalMv > 0 || totalPnl !== 0) && (() => {
                const totalPnlDisplay = formatPnl(totalPnl || undefined, totalCost || undefined);
                return (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border, #333)', fontWeight: 600 }}>
                      <td style={{ padding: '0.5rem' }} colSpan={5}>Total</td>
                      <td style={{ textAlign: 'right', padding: '0.5rem' }} className="mono">
                        {formatMoney(totalMv || null)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.5rem' }} className="mono dim">
                        {totalMv > 0 ? '100.0%' : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.5rem', color: totalPnlDisplay.color }} className="mono">
                        {totalPnlDisplay.text}
                      </td>
                    </tr>
                  </tfoot>
                );
              })()}
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
