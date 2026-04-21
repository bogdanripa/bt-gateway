/**
 * Firebase Admin SDK singleton.
 *
 * Server-only. Never import this from a file that's bundled to the client.
 *
 * Authentication: uses Application Default Credentials. On Cloud Run that
 * resolves to the runtime service account (`bt-gateway-runtime@...`). Locally
 * it resolves to the user's gcloud ADC. No JSON keys anywhere.
 *
 * We use Firebase Admin for two things:
 *   1. Verifying ID tokens on UI requests (`verifyIdToken`)
 *   2. Setting / reading custom claims, specifically `isAdmin: true`
 */

import 'server-only';
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
  // Application Default Credentials path: when running on Cloud Run, the
  // platform-provided metadata server supplies creds. Locally, gcloud ADC
  // resolves the same. No need to pass `credential` explicitly.
  app = initializeApp({ projectId: projectId() });
  return app;
}

export function adminAuth(): Auth {
  return getAuth(adminApp());
}
