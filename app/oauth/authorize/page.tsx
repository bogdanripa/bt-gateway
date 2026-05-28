/**
 * OAuth authorize endpoint as a Next.js page.
 *
 * Why a page instead of a route handler:
 *   - The user must be Firebase-signed-in to consent. The existing AuthGate
 *     pattern (used elsewhere in the app) handles the "sign in first, then
 *     return here" loop for us.
 *   - Once signed in, we render a small consent UI that lets the user pick
 *     `mode` (demo/live), optionally inherit filters from an existing API key,
 *     and pick read-only vs. read+write.
 *   - On "Allow", a server POST mints a one-shot authorization code and
 *     returns the redirect URL; we `location.replace` into it.
 */

'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthGate } from '@/components/auth/AuthGate';
import { uiFetch } from '@/lib/ui-client';

interface KeyRow {
  id: string;
  label: string;
  mode: 'demo' | 'live';
  prefix: string;
  hasFilters: boolean;
}

interface OauthContext {
  client: { client_id: string; client_name: string; redirect_uri: string };
  modes: { demo: boolean; live: boolean };
  keys: KeyRow[];
  params: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    state: string;
  };
}

function AuthorizeBody() {
  const sp = useSearchParams();
  const [ctx, setCtx] = useState<OauthContext | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [mode, setMode] = useState<'demo' | 'live' | null>(null);
  const [keyId, setKeyId] = useState<string>('__no_filters__');
  const [access, setAccess] = useState<'read' | 'rw'>('read');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const qs = sp.toString();
    uiFetch<OauthContext>(`/api/ui/oauth/context?${qs}`)
      .then((data) => {
        if (cancelled) return;
        setCtx(data);
        // Default mode = first one with creds.
        if (data.modes.live) setMode('live');
        else if (data.modes.demo) setMode('demo');
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr((e as Error).message);
      });
    return () => { cancelled = true; };
  }, [sp]);

  async function onApprove() {
    if (!ctx || !mode) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const { redirect } = await uiFetch<{ redirect: string }>('/api/ui/oauth/consent', {
        method: 'POST',
        body: JSON.stringify({
          ...ctx.params,
          mode,
          access,
          keyId: keyId === '__no_filters__' ? undefined : keyId,
        }),
      });
      window.location.replace(redirect);
    } catch (e) {
      setSubmitErr((e as Error).message);
      setSubmitting(false);
    }
  }

  function onDeny() {
    if (!ctx) return;
    // RFC 6749 §4.1.2.1: return access_denied to the client's redirect_uri.
    const url = new URL(ctx.params.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the request');
    if (ctx.params.state) url.searchParams.set('state', ctx.params.state);
    window.location.replace(url.toString());
  }

  if (loadErr) {
    return (
      <div className="card">
        <h2>Authorization request invalid</h2>
        <div className="notice err">{loadErr}</div>
        <p className="dim">Close this tab and ask the client to retry.</p>
      </div>
    );
  }
  if (!ctx) {
    return <div className="card"><p className="dim">Loading…</p></div>;
  }

  const eligibleKeys = mode ? ctx.keys.filter((k) => k.mode === mode) : [];
  const hasAnyMode = ctx.modes.demo || ctx.modes.live;

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2 style={{ marginTop: 0 }}>
        Authorize <strong>{ctx.client.client_name}</strong>?
      </h2>
      <p className="dim" style={{ marginTop: '-0.5rem' }}>
        It is asking to access your BT Trade data via bt-gateway.
      </p>

      {!hasAnyMode && (
        <div className="notice err" style={{ marginTop: '1rem' }}>
          You have no BT credentials configured yet. Set them up first under{' '}
          <a href="/console/settings">Settings</a>, then come back and retry.
        </div>
      )}

      {hasAnyMode && (
        <>
          <div style={{ marginTop: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.25rem' }}>Account</label>
            <div className="row" style={{ gap: '0.5rem' }}>
              {(['demo', 'live'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`pill ${m}`}
                  onClick={() => { setMode(m); setKeyId('__no_filters__'); }}
                  disabled={!ctx.modes[m]}
                  style={{
                    cursor: ctx.modes[m] ? 'pointer' : 'not-allowed',
                    opacity: ctx.modes[m] ? 1 : 0.4,
                    outline: mode === m ? '2px solid var(--accent, #4f8cff)' : 'none',
                  }}
                  title={ctx.modes[m] ? '' : `No ${m} credentials configured`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label htmlFor="oauth-keyid" style={{ display: 'block', marginBottom: '0.25rem' }}>
              Filters
            </label>
            <select
              id="oauth-keyid"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              style={{ width: '100%' }}
              disabled={!mode}
            >
              <option value="__no_filters__">No filters (full access in {mode ?? '—'})</option>
              {eligibleKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                  {k.hasFilters ? ' — inherits its filters' : ' — no filters'}
                </option>
              ))}
            </select>
            <p className="dim" style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>
              The MCP connection borrows the filter rules from this key. Pick &ldquo;No
              filters&rdquo; to grant unfiltered access within {mode ?? 'the chosen mode'}.
            </p>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.25rem' }}>Access</label>
            <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  type="radio"
                  name="access"
                  value="read"
                  checked={access === 'read'}
                  onChange={() => setAccess('read')}
                />
                Read-only (cash, holdings, orders, preview)
              </label>
              <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                <input
                  type="radio"
                  name="access"
                  value="rw"
                  checked={access === 'rw'}
                  onChange={() => setAccess('rw')}
                />
                Read + place orders
              </label>
            </div>
          </div>

          {submitErr && (
            <div className="notice err" style={{ marginTop: '1rem' }}>{submitErr}</div>
          )}

          <div className="row" style={{ marginTop: '1.5rem', gap: '0.5rem' }}>
            <button onClick={() => { void onApprove(); }} disabled={!mode || submitting}>
              {submitting ? 'Approving…' : 'Allow'}
            </button>
            <button type="button" onClick={onDeny} disabled={submitting}>
              Deny
            </button>
          </div>

          <p className="dim" style={{ fontSize: '0.75rem', marginTop: '1rem' }}>
            Granting this consent revokes any prior MCP connection on the same mode. You can
            revoke at any time from <a href="/console/settings">Settings</a>.
          </p>
        </>
      )}
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <AuthGate>
      <main style={{ padding: '2rem', display: 'flex', justifyContent: 'center' }}>
        <Suspense fallback={<div className="card"><p className="dim">Loading…</p></div>}>
          <AuthorizeBody />
        </Suspense>
      </main>
    </AuthGate>
  );
}
