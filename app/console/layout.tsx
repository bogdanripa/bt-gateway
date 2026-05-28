/**
 * Layout for `/console/*` — the Firebase-authenticated dashboard. This is
 * where the Firebase Web SDK config gets inlined and the AuthProvider +
 * ModeProvider contexts wrap the tree. The public marketing pages don't
 * mount any of this, keeping their HTML lean.
 *
 * `force-dynamic` is intentional: we inject env-derived config into the
 * page server-side, so the response can't be cached at the edge.
 */

import type { ReactNode } from 'react';
import Script from 'next/script';
import { getFirebaseClientConfig } from '@/lib/firebase/public-config';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ModeProvider } from '@/components/mode/ModeProvider';

export const dynamic = 'force-dynamic';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const fb = getFirebaseClientConfig();
  return (
    <>
      <Script
        id="bt-firebase-config"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: `window.__bt_firebase__=${JSON.stringify(fb)};`,
        }}
      />
      <AuthProvider>
        <ModeProvider>{children}</ModeProvider>
      </AuthProvider>
    </>
  );
}
