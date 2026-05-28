/**
 * sitemap.xml for the public marketing pages.
 */

import type { MetadataRoute } from 'next';

const SITE_URL =
  process.env.BT_GATEWAY_PUBLIC_URL?.replace(/\/+$/, '') ??
  'https://bt-gateway.bogdanripa.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/`,            lastModified, changeFrequency: 'monthly', priority: 1.0 },
    { url: `${SITE_URL}/setup/live`,  lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/setup/demo`,  lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE_URL}/docs`,        lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/privacy`,     lastModified, changeFrequency: 'yearly',  priority: 0.3 },
    { url: `${SITE_URL}/terms`,       lastModified, changeFrequency: 'yearly',  priority: 0.3 },
  ];
}
