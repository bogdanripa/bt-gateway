/**
 * GET /api/health
 *
 * Liveness + egress-IP probe. The `egressIp` field is critical for M1: it
 * confirms the Cloud Run service is actually leaving GCP via our reserved
 * static external IP (Cloud NAT), not via Google's shared egress pool. BT
 * Trade pins refresh tokens to the originating IP, so without a stable
 * egress the whole gateway premise falls apart.
 *
 * On M1 exit we hit this endpoint 20× in a row and expect the same IP every
 * time. If it rotates, the VPC / NAT wiring is wrong.
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
