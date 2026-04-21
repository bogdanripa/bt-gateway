/**
 * Next.js config for bt-gateway.
 *
 * `output: 'standalone'` produces a self-contained .next/standalone directory
 * that the Dockerfile copies into a minimal runtime image. This keeps the
 * Cloud Run container small (~150 MB instead of ~1 GB with node_modules).
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Trace the monorepo root to the repo root; avoids "multiple lockfiles"
  // warnings when this directory is nested inside another workspace.
  outputFileTracingRoot: new URL('.', import.meta.url).pathname,
  experimental: {
    // Keeps server-only secrets from leaking into client bundles via tree-shake.
    serverSourceMaps: false,
  },
};

export default nextConfig;
