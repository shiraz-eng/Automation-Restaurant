import type { IncomingMessage, ServerResponse } from 'http';
import { app } from '../src/app';

/**
 * Vercel serverless entry point. vercel.json rewrites every path to this
 * function while preserving the original req.url, so Express's own router
 * (mounted on /api/... plus /health) matches exactly as it does locally —
 * this file is a thin adapter, not a second copy of the routing table.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  app(req, res);
}
