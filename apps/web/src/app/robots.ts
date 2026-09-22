import type { MetadataRoute } from 'next';

const SITE_URL = 'https://automationrestaurant.app';

// Only the public marketing site should be indexed — every tenant's portal,
// the admin console and onboarding/checkout flows are authenticated
// application surfaces, not public pages.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/pricing', '/contact', '/get-started', '/privacy-policy', '/terms-and-conditions'],
      disallow: ['/r/', '/admin/', '/onboarding/', '/order/', '/login', '/api/'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
