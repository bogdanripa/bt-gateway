/**
 * Canonical public origin, baked in at build time.
 *
 * Used for JSON-LD / canonical links on the marketing pages, so it must be the
 * real public origin rather than whatever host the browser happens to be on —
 * deriving it from `window.location` would emit the wrong canonical whenever
 * the page is opened through any other hostname.
 */
export const SITE_URL = (
  import.meta.env.VITE_PUBLIC_URL || 'https://bt-gateway-coolify.bogdanripa.com'
).replace(/\/+$/, '');
