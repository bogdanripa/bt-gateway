/**
 * robots.txt for crawlers (Google, Bing, GPTBot, PerplexityBot, etc.).
 *
 * Public marketing pages are crawlable. The dashboard, OAuth surface, and
 * API are not — they require auth and contain no value for indexing.
 */

import type { MetadataRoute } from 'next';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: ['/api/', '/console/', '/oauth/', '/mcp', '/.well-known/'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
