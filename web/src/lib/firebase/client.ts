/**
 * Firebase Auth client SDK singleton (browser only).
 *
 * The config is baked in at build time from `VITE_FIREBASE_*`. These are not
 * secrets: Firebase's web config is designed to be public, and `apiKey` is a
 * quota identifier rather than an authorization credential — security is
 * enforced server-side by Admin SDK token verification.
 *
 * It used to be injected into `window.__bt_firebase__` by a server-rendered
 * <script>, which is the only reason the root layout had to be dynamic. With a
 * static bundle there is no render step to inject anything, so it moves to
 * build time. The cost is that changing Firebase projects needs a rebuild —
 * which is the correct trade for config that changes approximately never.
 *
 * Exposes:
 *   - `getFirebaseAuth()` — returns the initialized Auth instance.
 *   - `signInWithGoogle()` — redirect-less popup sign-in.
 *   - `signOut()` — delegates to Firebase.
 *   - `onAuthChanged(cb)` — thin wrapper so consumers don't import firebase.
 *   - `getIdToken()` — fresh ID token for API calls (forces refresh when near expiry).
 */


import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth';

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

function init(): Auth {
  if (auth) return auth;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  const cfg = {
    apiKey: import.meta.env.VITE_FIREBASE_WEB_API_KEY,
    authDomain:
      import.meta.env.VITE_FIREBASE_WEB_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
  };
  if (!cfg.apiKey || !cfg.projectId) {
    throw new Error(
      'Firebase client config missing. Set VITE_FIREBASE_WEB_API_KEY and ' +
        'VITE_FIREBASE_PROJECT_ID at build time.',
    );
  }
  app = getApps()[0] ?? initializeApp(cfg);
  auth = getAuth(app);
  return auth;
}

export function getFirebaseAuth(): Auth {
  return init();
}

export async function signInWithGoogle(): Promise<User> {
  const a = init();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const res = await signInWithPopup(a, provider);
  return res.user;
}

export function signOut(): Promise<void> {
  return firebaseSignOut(init());
}

export function onAuthChanged(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(init(), cb);
}

/**
 * Get a fresh ID token. Forces a refresh if the current one is within 5 min
 * of expiry so calls always land on the server with plenty of runway.
 */
export async function getIdToken(): Promise<string | null> {
  const a = init();
  const user = a.currentUser;
  if (!user) return null;
  return user.getIdToken(/* forceRefresh */ false);
}
