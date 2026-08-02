/**
 * GET /api/health
 *
 * Liveness + egress-IP probe. This is also the app's configured health_path,
 * so the container healthcheck and the deploy's "wait for healthy" step both
 * request it — it must stay unauthenticated and must not depend on the
 * database, or a transient Postgres blip turns into a rolled-back deploy.
 *
 * The `egressIp` field remains the single most useful diagnostic here. BT
 * Trade pins refresh tokens to the IP that issued them, so a change in this
 * value is the direct cause of a fleet-wide `IP diferit`. On Cloud Run it
 * confirmed traffic was leaving through the reserved static NAT address;
 * on the Pi it reports the home broadband IP, which is stable in practice
 * but is not contractually static. If sessions start dying en masse, hit
 * this first and compare the IP against what it was.
 *
 * Intentionally unauthenticated. Returns no tenant-sensitive data.
 */

import { NextResponse } from 'next/server';

// `force-dynamic` defeats Next's route caching — the egress probe must always
// be fresh or it'd return a stale lookup from build time.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function lookupEgressIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      // Short timeout — health checks fire on cold starts and from the
      // uptime monitor; we don't want a slow ipify request to make the
      // probe look unhealthy.
      // 8s, not 2s — cold-path VPC Connector adds a few seconds on first
      // egress. Tight timeouts here produce false "null" readings that are
      // indistinguishable from actual NAT/routing failure.
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ip?: string };
    return body.ip ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const egressIp = await lookupEgressIp();
  return NextResponse.json(
    {
      ok: true,
      service: 'bt-gateway',
      commit: process.env.BT_GATEWAY_COMMIT ?? 'dev',
      egressIp,
      ts: new Date().toISOString(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
