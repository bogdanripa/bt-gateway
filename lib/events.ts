/**
 * Audit log append helper.
 *
 * Only MUTATING events land in users/{uid}/events. Reads (cash, holdings,
 * orders list) do not — they're ops-only and live in Cloud Logging via
 * the structured-log emission in each route handler.
 *
 * Every append also emits a structured JSON line to stdout so you can
 * correlate user-facing audit rows with Cloud Logging queries by
 * `requestId` or `uid`.
 */

import 'server-only';
import { appendEvent, type EventDoc, type TenantRef } from './firestore';

type AppendArgs = {
  tenant: TenantRef;
  type: EventDoc['type'];
  actor: string;
  status: 'ok' | 'err';
  mode?: EventDoc['mode'];
  detail?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  requestId?: string;
};

export async function audit(args: AppendArgs): Promise<void> {
  const ev: EventDoc = {
    type: args.type,
    actor: args.actor,
    status: args.status,
    mode: args.mode,
    detail: args.detail,
    error: args.error,
    ts: new Date().toISOString(),
  };
  // Write to Firestore (the UI feed).
  try {
    await appendEvent(args.tenant, ev);
  } catch (e) {
    // Never let an audit write take down the request. Cloud Logging still
    // captures it, so nothing is silently lost.
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'audit.firestore_write_failed',
        requestId: args.requestId,
        uid: args.tenant.uid,
        err: (e as Error).message,
      }),
    );
  }
  // Also emit to stdout as structured JSON for Cloud Logging.
  console.log(
    JSON.stringify({
      severity: args.status === 'err' ? 'WARNING' : 'INFO',
      msg: `audit.${args.type}`,
      requestId: args.requestId,
      uid: args.tenant.uid,
      actor: args.actor,
      mode: args.mode,
      status: args.status,
      detail: args.detail,
      error: args.error,
      ts: ev.ts,
    }),
  );
}
