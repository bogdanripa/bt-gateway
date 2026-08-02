/**
 * Firebase client (browser) SDK config.
 *
 * These values are NOT secrets — Firebase is designed for the Web SDK config
 * to be public. `apiKey` here is an identifier for Firebase API quota, not an
 * authorization credential (that's what the ID token is). Security is
 * enforced server-side by Admin SDK token verification.
 *
 * We read them at RENDER time from server-only env (no NEXT_PUBLIC_ prefix
 * needed) and inject them into the HTML via a tiny inline script, which the
 * client module picks up. This avoids needing build-time env plumbing in
 * Dockerfile + GitHub Actions.
 */


export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export function getFirebaseClientConfig(): FirebaseClientConfig {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY ?? '',
    authDomain:
      process.env.FIREBASE_WEB_AUTH_DOMAIN ??
      `${process.env.FIREBASE_PROJECT_ID ?? 'auto-trader-493814'}.firebaseapp.com`,
    projectId:
      process.env.FIREBASE_PROJECT_ID ??
      process.env.GOOGLE_CLOUD_PROJECT ??
      'auto-trader-493814',
  };
}
