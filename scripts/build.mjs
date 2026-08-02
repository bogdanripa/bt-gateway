#!/usr/bin/env node
/**
 * Bundle the API server with esbuild.
 *
 * Why bundle at all rather than just running `tsc`: `@bogdanripa/bt-trade` is
 * ESM-only while `firebase-admin` and `pg` are CommonJS, so the output has to
 * be ESM — and ESM requires explicit `.js` extensions on every relative import.
 * Bundling sidesteps that across ~60 files, and lets the `@/*` alias keep
 * working (esbuild reads the `paths` mapping out of tsconfig.json).
 *
 * `packages: 'external'` keeps node_modules out of the bundle: firebase-admin
 * does dynamic requires that do not survive bundling, and the runtime image
 * installs production dependencies anyway. The output is one file plus a
 * normal node_modules tree.
 */

import { build, context } from 'esbuild';
import { rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  sourcemap: true,
  // Node's ESM loader has no `__dirname`; nothing here uses it, but a stray
  // dependency shim can, and this fails loudly at build time instead.
  logLevel: 'info',
  tsconfig: 'tsconfig.json',
};

await rm('dist', { recursive: true, force: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(options);
}
