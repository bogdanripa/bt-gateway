import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'bt-gateway',
  description: 'Multi-tenant BT Trade HTTP gateway',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#0b0d10',
          color: '#e6e8eb',
        }}
      >
        {children}
      </body>
    </html>
  );
}
