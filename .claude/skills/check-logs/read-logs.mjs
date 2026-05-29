#!/usr/bin/env node
/**
 * Portable bt-gateway log reader for the /check-logs skill.
 *
 * Calls the Cloud Logging REST API (logging.googleapis.com/v2/entries:list)
 * using Application Default Credentials via google-auth-library. This is the
 * ONE code path the skill uses everywhere, so output is identical regardless
 * of where it runs:
 *   - Laptop  → ADC from `gcloud auth application-default login` (your user).
 *   - Routine / Claude on phone → ADC from GOOGLE_APPLICATION_CREDENTIALS
 *     pointing at the bt-gateway-runtime SA key (needs roles/logging.viewer).
 *
 * google-auth-library is a transitive dep already in node_modules, so this
 * runs after a plain `npm install` with no gcloud binary present.
 *
 * Usage:
 *   node read-logs.mjs --filter '<extra log filter>' --freshness 1h \
 *     --limit 50 [--order desc|asc] [--json]
 *
 * --filter is ANDed onto the fixed resource filter. Omit/empty for all.
 * --json dumps full jsonPayload per entry (for requestId drill-downs);
 *   default is a compact one-line-per-entry table.
 */

import { GoogleAuth } from 'google-auth-library';

const PROJECT = 'auto-trader-493814';
const SERVICE = 'bt-gateway';
const RESOURCE_FILTER = `resource.type="cloud_run_revision" AND resource.labels.service_name="${SERVICE}"`;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

// --- freshness (e.g. 30m / 6h / 7d) → RFC3339 lower bound ------------------
function freshnessToIso(fresh) {
  const m = /^(\d+)([mhd])$/.exec(fresh || '1h');
  if (!m) throw new Error(`bad --freshness "${fresh}" (use 30m / 6h / 7d)`);
  const n = Number(m[1]);
  const ms = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] * n;
  return new Date(Date.now() - ms).toISOString();
}

const extra = (arg('filter', '') || '').trim();
const since = freshnessToIso(arg('freshness', '1h'));
const limit = Math.max(1, Math.min(1000, Number(arg('limit', '50')) || 50));
const order = arg('order', 'desc') === 'asc' ? 'asc' : 'desc';
const asJson = has('json');

const filter = [RESOURCE_FILTER, `timestamp>="${since}"`, extra]
  .filter(Boolean)
  .join(' AND ');

async function main() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('no access token — is ADC configured? (GOOGLE_APPLICATION_CREDENTIALS / gcloud auth application-default login)');

  const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${PROJECT}`],
      filter,
      orderBy: `timestamp ${order}`,
      pageSize: limit,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Logging API ${res.status}: ${body.slice(0, 500)}`);
  }
  const entries = (await res.json()).entries || [];

  if (entries.length === 0) {
    console.log(`(no entries) filter: ${filter}`);
    return;
  }

  if (asJson) {
    for (const e of entries) {
      console.log(JSON.stringify({ timestamp: e.timestamp, severity: e.severity, ...(e.jsonPayload || { textPayload: e.textPayload }) }));
    }
    return;
  }

  // Compact table: time | sev | msg | status | code | path | ms | requestId
  const rows = entries.map((e) => {
    const p = e.jsonPayload || {};
    const t = new Date(e.timestamp).toISOString().slice(11, 19);
    return [
      t,
      (e.severity || '').padEnd(7),
      String(p.msg ?? '(text)').padEnd(26),
      String(p.status ?? '').padEnd(4),
      String(p.code ?? '').padEnd(14),
      String(p.path ?? '').padEnd(22),
      String(p.latencyMs ?? '').padStart(6),
      String(p.requestId ?? ''),
    ].join('  ');
  });
  console.log(`TIME      SEV      MSG                         STAT  CODE            PATH                       MS  REQUEST_ID`);
  console.log(rows.join('\n'));
  console.log(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · window since ${since}`);
}

main().catch((e) => {
  console.error(`check-logs read failed: ${e.message}`);
  process.exit(1);
});
