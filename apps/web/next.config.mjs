import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '../..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@automation-restaurant/shared'],
  outputFileTracingRoot: monorepoRoot,
};

export default nextConfig;
