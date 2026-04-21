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
