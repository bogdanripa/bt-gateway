'use client';

import { useCallback, useEffect, useState } from 'react';
import { uiFetch } from '@/lib/ui-client';
import { useMode, type Mode } from './mode/ModeProvider';

interface SessionInfo {
  mode: Mode;
  hasSession: boolean;
  sessionUpdatedAt: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  sessionId: string | null;
  lastKnownState: Record<string, unknown> | null;
}

interface Response {
  sessions: SessionInfo[];
}

function fmtAbs(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ro-RO', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function fmtRelative(iso: string | null, now: number): { text: string; expired: boolean } {
  if (!iso) return { text: '—', expired: false };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { text: iso, expired: false };
  const diff = t - now;
  const expired = diff <= 0;
  const abs = Math.abs(diff);
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  let unit: string;
  if (d >= 1) unit = `${d}d ${h % 24}h`;
  else if (h >= 1) unit = `${h}h ${m % 60}m`;
  else if (m >= 1) unit = `${m}m ${s % 60}s`;
  else unit = `${s}s`;
  return { text: expired ? `expired ${unit} ago` : `in ${unit}`, expired };
}

function extractCash(state: Record<string, unknown> | null): { available?: number; total?: number; currency?: string } {
  if (!state) return {};
  const cash = state['cash'];
  if (cash && typeof cash === 'object') {
    const c = cash as Record<string, unknown>;
    return {
      available: typeof c['availableAmount'] === 'number' ? (c['availableAmount'] as number) : undefined,
      total: typeof c['totalAmount'] === 'number' ? (c['totalAmount'] as number) : undefined,
      currency: typeof c['currencyId'] === 'string' ? (c['currencyId'] as string) : undefined,
    };
  }
  return {};
}

function extractHoldingsCount(state: Record<string, unknown> | null): number | null {
  if (!state) return null;
  const h = state['holdings'];
  if (Array.isArray(h)) return h.length;
  if (h && typeof h === 'object') {
    const items = (h as Record<string, unknown>)['items'];
    if (Array.isArray(items)) return items.length;
  }
  return null;
}

function extractStateTimestamp(state: Record<string, unknown> | null): string | null {
  if (!state) return null;
  for (const k of ['updatedAt', 'fetchedAt', 'as_of', 'asOf', 'ts', 'timestamp']) {
    const v = state[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

export function SessionStatus() {
  const { mode } = useMode();
  const [data, setData] = useState<Response | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await uiFetch<Response>('/api/ui/sessions');
      setData(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Tick every second so the "in 27m" countdowns stay live without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: '1rem' }}>
        <h2 style={{ margin: 0 }}>Session & last known state</h2>
        <div style={{ flex: 1 }} />
        <button onClick={() => { void load(); }} disabled={loading} className="ghost">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {err && <div className="notice err" style={{ marginTop: '1rem' }}>{err}</div>}

      {data && (
        <div style={{ marginTop: '1rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
          {data.sessions.filter(s => s.mode === mode).map(s => {
            const accRel = fmtRelative(s.accessTokenExpiresAt, now);
            const refRel = fmtRelative(s.refreshTokenExpiresAt, now);
            const cash = extractCash(s.lastKnownState);
            const positions = extractHoldingsCount(s.lastKnownState);
            const stateTs = extractStateTimestamp(s.lastKnownState);

            return (
              <div key={s.mode} style={{ border: '1px solid var(--border, #333)', borderRadius: 6, padding: '0.75rem 1rem' }}>
                <div className="row" style={{ alignItems: 'baseline', gap: '0.5rem' }}>
                  <h3 style={{ margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.mode}</h3>
                  <span className="dim" style={{ fontSize: '0.8rem' }}>
                    {s.hasSession ? 'session cached' : 'no session'}
                  </span>
                </div>

                <dl style={{ margin: '0.75rem 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', fontSize: '0.9rem' }}>
                  <dt className="dim">Access token</dt>
                  <dd className="mono" style={{ margin: 0, color: accRel.expired ? 'var(--err, #f44336)' : undefined }}>
                    {accRel.text}
                    {s.accessTokenExpiresAt && (
                      <span className="dim" style={{ fontSize: '0.75rem' }}>  · {fmtAbs(s.accessTokenExpiresAt)}</span>
                    )}
                  </dd>

                  <dt className="dim">Refresh token</dt>
                  <dd className="mono" style={{ margin: 0, color: refRel.expired ? 'var(--err, #f44336)' : undefined }}>
                    {refRel.text}
                    {s.refreshTokenExpiresAt && (
                      <span className="dim" style={{ fontSize: '0.75rem' }}>  · {fmtAbs(s.refreshTokenExpiresAt)}</span>
                    )}
                  </dd>

                  <dt className="dim">Session updated</dt>
                  <dd className="mono" style={{ margin: 0 }}>{fmtAbs(s.sessionUpdatedAt)}</dd>

                  {s.sessionId && (
                    <>
                      <dt className="dim">Session ID</dt>
                      <dd className="mono" style={{ margin: 0, fontSize: '0.75rem', wordBreak: 'break-all' }}>{s.sessionId}</dd>
                    </>
                  )}
                </dl>

                <hr style={{ border: 0, borderTop: '1px solid var(--border, #333)', margin: '0.75rem 0' }} />

                <div className="dim" style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                  Last known state {stateTs ? <>· as of {fmtAbs(stateTs)}</> : null}
                </div>
                {s.lastKnownState ? (
                  <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', fontSize: '0.9rem' }}>
                    <dt className="dim">Available cash</dt>
                    <dd className="mono" style={{ margin: 0 }}>
                      {cash.available !== undefined
                        ? `${cash.available.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cash.currency ?? 'RON'}`
                        : '—'}
                    </dd>
                    {cash.total !== undefined && cash.total !== cash.available && (
                      <>
                        <dt className="dim">Total cash</dt>
                        <dd className="mono" style={{ margin: 0 }}>
                          {cash.total.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {cash.currency ?? 'RON'}
                        </dd>
                      </>
                    )}
                    <dt className="dim">Positions</dt>
                    <dd className="mono" style={{ margin: 0 }}>{positions ?? '—'}</dd>
                  </dl>
                ) : (
                  <div className="dim" style={{ fontSize: '0.85rem' }}>
                    No cached state yet — run <span className="mono">bt_executor status</span> to populate it.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
