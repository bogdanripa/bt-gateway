/**
 * Route table for the SPA.
 *
 * Two families of route, and the split is deliberate:
 *
 *   - **Marketing** (`/`, `/docs`, `/privacy`, `/terms`, `/setup/*`) mounts no
 *     providers and never touches Firebase. Under Next these were server
 *     components for the same reason: a visitor reading the privacy page
 *     should not be made to download and initialise an auth SDK.
 *   - **Authenticated** (`/console/*`, `/oauth/authorize`) mounts AuthProvider
 *     and ModeProvider, which is what the old `console/layout.tsx` and
 *     `oauth/layout.tsx` did.
 *
 * The Firebase config used to be injected here by a server-rendered <script>,
 * which is the only thing that forced the root layout to be dynamic. It is
 * baked in at build time now (see lib/firebase/client.ts), so there is nothing
 * to inject and no layout to keep dynamic.
 */

import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from '@/components/auth/AuthProvider';
import { ModeProvider } from '@/components/mode/ModeProvider';

import { LandingPage } from '@/pages/Home';
import { DocsPage } from '@/pages/Docs';
import { PrivacyPage } from '@/pages/Privacy';
import { TermsPage } from '@/pages/Terms';
import { SetupDemoPage } from '@/pages/SetupDemo';
import { SetupLivePage } from '@/pages/SetupLive';
import { HomePage as ConsolePage } from '@/pages/Console';
import { SettingsPage } from '@/pages/ConsoleSettings';
import { AuthorizePage } from '@/pages/OauthAuthorize';

function Authed({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ModeProvider>{children}</ModeProvider>
    </AuthProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/setup/demo" element={<SetupDemoPage />} />
      <Route path="/setup/live" element={<SetupLivePage />} />

      <Route path="/console" element={<Authed><ConsolePage /></Authed>} />
      <Route path="/console/settings" element={<Authed><SettingsPage /></Authed>} />
      <Route path="/oauth/authorize" element={<Authed><AuthorizePage /></Authed>} />

      {/* Unknown client-side paths are a mistyped URL, not a 404 from the API —
          send them home rather than showing a dead end. Paths the backend owns
          never reach here: the static host forwards anything not in the bundle
          straight to the container. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
