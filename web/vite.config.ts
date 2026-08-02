import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * The SPA is uploaded to the platform's static frontend host, which serves any
 * path present in the bundle and forwards everything else to the backend
 * container. So `/api/*` must NOT exist in the bundle — there is nothing to
 * configure for that, it simply follows from not emitting those paths.
 *
 * In dev there is no such host, so proxy `/api` to a locally running server.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 3000,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/oauth': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/.well-known': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    // index.html must land at the zip root for the frontend upload.
    emptyOutDir: true,
    sourcemap: false,
  },
});
