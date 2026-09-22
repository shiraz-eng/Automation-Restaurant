import type { MetadataRoute } from 'next';

const SITE_URL = 'https://automationrestaurant.app';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ['', '/pricing', '/contact', '/get-started', '/privacy-policy', '/terms-and-conditions'];
  return pages.map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: new Date(),
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : path === '/pricing' ? 0.8 : 0.5,
  }));
}
