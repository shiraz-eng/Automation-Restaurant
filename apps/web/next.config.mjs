import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@automation-restaurant/shared'],
  // A stray package-lock.json in the user's home dir confuses Next's root
  // inference; pin it to this app.
  outputFileTracingRoot: here,
};

export default nextConfig;
