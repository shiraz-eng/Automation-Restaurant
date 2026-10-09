import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Vercel monorepo: output file tracing must reach the workspace root so
// the shared package (packages/shared) is included in the deployment bundle.
const workspaceRoot = resolve(here, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(process.env.VERCEL ? {} : { output: 'standalone' }),
  transpilePackages: ['@automation-restaurant/shared'],
  outputFileTracingRoot: workspaceRoot,
  // The fixed role pages were removed — every staff role now uses the main
  // portal. Old bookmarks land on the matching main-portal page, whose own
  // permission gate still applies. (/finance is a real page again — the
  // Finance overview — so it is no longer redirected.)
  async redirects() {
    const moved = { kitchen: 'kds', floor: 'tables', deliveries: 'orders', register: 'checkout', team: 'staff' };
    return Object.entries(moved).map(([from, to]) => ({
      source: `/r/:slug/${from}`,
      destination: `/r/:slug/${to}`,
      permanent: false,
    }));
  },
  async headers() {
    return [
      {
        source: '/admin/cms/preview/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https: http:" },
        ],
      },
    ];
  },
};

export default nextConfig;
