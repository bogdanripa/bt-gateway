/**
 * Layout for `/oauth/*` — wraps the consent page in the same Firebase /
 * AuthProvider context the dashboard uses. The route handlers under
 * `/oauth/{register,token,revoke}` are NOT affected by this layout (Next.js
 * only applies layouts to `page.tsx`, not `route.ts`).
 */

import type { ReactNode } from 'react';
import Script from 'next/script';
import { getFirebaseClientConfig } from '@/lib/firebase/public-config';
import { AuthProvider } from '@/components/auth/AuthProvider';
import { ModeProvider } from '@/components/mode/ModeProvider';

export const dynamic = 'force-dynamic';

export default function OauthLayout({ children }: { children: ReactNode }) {
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
