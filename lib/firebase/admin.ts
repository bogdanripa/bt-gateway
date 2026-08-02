/**
 * Firebase Admin SDK singleton.
 *
 * Server-only. Never import this from a file that's bundled to the client.
 *
 * Authentication: none needed, and that is deliberate. This app runs off GCP
 * now, so there is no metadata server and no service-account key. The only
 * thing we ask the Admin SDK to do is `verifyIdToken`, which validates the
 * token's signature against Google's public x509 certs — a plain HTTPS fetch
 * of published keys. It needs the project ID to check the `aud`/`iss` claims;
 * it does not need a credential.
 *
 * That is why `projectId` is passed explicitly below rather than left for the
 * SDK to discover: discovery would try the GCE metadata server, which on this
 * host is a hang followed by a failure.
 *
 * The consequence to know about: anything that MINTS credentials or WRITES to
 * Firebase (setCustomUserClaims, createCustomToken, verifyIdToken's
 * `checkRevoked` option) would need a real credential and will fail here.
 * `isAdmin` is read from the verified token's claims, and is set out-of-band.
 */

import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';

function projectId(): string {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    // Last-ditch fallback for local dev before we export the var.
    'auto-trader-493814'
  );
}

let app: App | null = null;

export function adminApp(): App {
  if (app) return app;
  if (getApps().length > 0) {
    app = getApps()[0]!;
    return app;
  }
  // No `credential` on purpose — see the note at the top of this file. The
  // explicit projectId is what keeps the SDK from probing for one.
  app = initializeApp({ projectId: projectId() });
  return app;
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}
