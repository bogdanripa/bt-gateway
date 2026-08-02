/**
 * OAuth authorize endpoint as a page rather than an API route.
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


import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  // Destructure — react-router's useSearchParams returns [params, setParams].
  // Holding the whole tuple broke this page twice over: `sp.toString()` was
  // Array.prototype.toString, which appended the setter's source text to the
  // last query param, and the tuple is a fresh array each render, so the
  // effect below re-fired on *every* state change and reset `mode` back to
  // demo the moment you clicked live. `qs` is a string, so it compares by
  // value and the fetch happens once.
  const [sp] = useSearchParams();
  const qs = sp.toString();
  const [ctx, setCtx] = useState<OauthContext | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [mode, setMode] = useState<'demo' | 'live' | null>(null);
  const [keyId, setKeyId] = useState<string>('__no_filters__');
  const [access, setAccess] = useState<'read' | 'rw'>('read');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    uiFetch<OauthContext>(`/api/ui/oauth/context?${qs}`)
      .then((data) => {
        if (cancelled) return;
        setCtx(data);
        // Default mode = demo when available (lower-risk first pick).
        if (data.modes.demo) setMode('demo');
        else if (data.modes.live) setMode('live');
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr((e as Error).message);
      });
    return () => { cancelled = true; };
  }, [qs]);

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
        It is asking to access your BT Trade data via BT Gateway.
      </p>

      {!hasAnyMode && (
        <div className="notice err" style={{ marginTop: '1rem' }}>
          You have no BT credentials configured yet. Set them up first under{' '}
          <a href="/console/settings">Settings</a>, then come back and retry.
        </div>
      )}

      {hasAnyMode && (
        <>
          <fieldset className="consent-group">
            <legend>Account</legend>
            <div className="consent-choice-grid">
              {(['demo', 'live'] as const).map((m) => {
                const available = ctx.modes[m];
                const selected = mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    className={`consent-choice consent-choice--${m}${selected ? ' is-selected' : ''}`}
                    onClick={() => { setMode(m); setKeyId('__no_filters__'); }}
                    disabled={!available}
                    title={available ? '' : `No ${m} credentials configured`}
                    aria-pressed={selected}
                  >
                    <span className="consent-choice__title">{m}</span>
                    <span className="consent-choice__desc">
                      {m === 'demo'
                        ? 'Paper-trading account (play money). Safer first pick.'
                        : 'Real account. Orders move real money.'}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="consent-group">
            <legend>What it can do</legend>
            <div className="consent-choice-grid">
              <button
                type="button"
                className={`consent-choice${access === 'read' ? ' is-selected' : ''}`}
                onClick={() => setAccess('read')}
                aria-pressed={access === 'read'}
              >
                <span className="consent-choice__title">Read only</span>
                <span className="consent-choice__desc">
                  See cash, holdings, and orders. Preview trades, but never place them.
                </span>
              </button>
              <button
                type="button"
                className={`consent-choice${access === 'rw' ? ' is-selected' : ''}`}
                onClick={() => setAccess('rw')}
                aria-pressed={access === 'rw'}
              >
                <span className="consent-choice__title">Read &amp; place orders</span>
                <span className="consent-choice__desc">
                  Everything in &ldquo;Read only&rdquo;, plus the ability to place orders
                  on your behalf.
                </span>
              </button>
            </div>
          </fieldset>

          <fieldset className="consent-group">
            <legend>Filters (optional)</legend>
            <select
              id="oauth-keyid"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
              style={{ width: '100%' }}
              disabled={!mode}
            >
              <option value="__no_filters__">No filters &mdash; full access in {mode ?? '—'}</option>
              {eligibleKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                  {k.hasFilters ? ' — inherits its filters' : ''}
                </option>
              ))}
            </select>
            <p className="dim" style={{ fontSize: '0.8rem', marginTop: '0.4rem', marginBottom: 0 }}>
              Borrow filter rules (market / currency / symbol allowlists) from one of your
              existing API keys, or leave unfiltered.
            </p>
          </fieldset>

          {submitErr && (
            <div className="notice err" style={{ marginTop: '1rem' }}>{submitErr}</div>
          )}

          <div className="consent-actions">
            <button
              className="consent-action consent-action--primary"
              onClick={() => { void onApprove(); }}
              disabled={!mode || submitting}
            >
              {submitting ? 'Approving…' : 'Allow'}
            </button>
            <button
              type="button"
              className="consent-action consent-action--ghost"
              onClick={onDeny}
              disabled={submitting}
            >
              Deny
            </button>
          </div>

          <p className="dim" style={{ fontSize: '0.75rem', marginTop: '1rem' }}>
            Granting this consent revokes any prior MCP connection on the same mode. You
            can revoke at any time from <a href="/console/settings">Settings</a>.
          </p>
        </>
      )}
    </div>
  );
}

export function AuthorizePage() {
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
