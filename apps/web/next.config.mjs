import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Vercel monorepo: output file tracing must reach the workspace root so
// the shared package (packages/shared) is included in the deployment bundle.
const workspaceRoot = resolve(here, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@automation-restaurant/shared'],
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
