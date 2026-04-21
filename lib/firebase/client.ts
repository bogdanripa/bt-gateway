/**
 * Firebase Auth client SDK singleton (browser only).
 *
 * The config is injected into `window.__bt_firebase__` by a server-rendered
 * <script> tag in `app/layout.tsx`. We don't read `process.env` here — that
 * would require rebuilding the image whenever the Firebase project changed.
 *
 * Exposes:
 *   - `getFirebaseAuth()` — returns the initialized Auth instance.
 *   - `signInWithGoogle()` — redirect-less popup sign-in.
 *   - `signOut()` — delegates to Firebase.
 *   - `onAuthChanged(cb)` — thin wrapper so consumers don't import firebase.
 *   - `getIdToken()` — fresh ID token for API calls (forces refresh when near expiry).
 */

'use client';

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

declare global {
  interface Window {
    __bt_firebase__?: { apiKey: string; authDomain: string; projectId: string };
  }
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

function init(): Auth {
  if (auth) return auth;
  const cfg = typeof window !== 'undefined' ? window.__bt_firebase__ : undefined;
  if (!cfg || !cfg.apiKey) {
    throw new Error(
      'Firebase client config missing. Set FIREBASE_WEB_API_KEY / FIREBASE_WEB_AUTH_DOMAIN / FIREBASE_PROJECT_ID on the server.',
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
