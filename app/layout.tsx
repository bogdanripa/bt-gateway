import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { getFirebaseClientConfig } from '@/lib/firebase/public-config';
import { AuthProvider } from '@/components/auth/AuthProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'bt-gateway',
  description: 'Multi-tenant BT Trade HTTP gateway',
};

// IMPORTANT: force per-request rendering. The root layout injects the
// Firebase Web SDK config from server env into the HTML via <Script>. If
// the layout were static-rendered at build time, the GitHub Actions build
// step would bake empty strings (the env vars live on Cloud Run, not in
// the build image), and no amount of redeploy would refresh them.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  // Server-side: read Firebase Web SDK config from env and inline it into
  // the page so the client SDK can initialize without a network round-trip.
  // These are NOT secrets (Firebase Web config is public by design).
  const fb = getFirebaseClientConfig();

  return (
    <html lang="en">
      <head>
        <Script
          id="bt-firebase-config"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.__bt_firebase__=${JSON.stringify(fb)};`,
          }}
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
