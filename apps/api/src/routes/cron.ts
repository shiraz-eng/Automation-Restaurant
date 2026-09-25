import express, { type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { runLowStockSweepAllTenants } from '../lib/lowStockAutomation';
import { runRecipeCostSweepAllTenants } from '../lib/recipeAutomation';
import { runAttendanceAutoAbsentSweepAllTenants } from '../lib/attendanceAutomation';

/**
 * Background jobs for serverless hosting. server.ts runs these on a
 * setInterval, but on Vercel (api/index.ts) there is no long-running
 * process, so they never ran there — no low-stock supplier emails, no
 * recipe-cost tracking, no automatic absences. A scheduler (pg_cron in the
 * control-plane database, see scripts/setup-cron.ts) calls these instead.
 *
 * Auth: `Authorization: Bearer <token>`, where token is either CRON_SECRET
 * (when set) or an HMAC derived from the server's own service-role key —
 * so no extra secret has to be configured for it to work. Each job is
 * idempotent (e.g. a reorder email is sent at most once per low-stock
 * event), so a repeated call never duplicates anything.
 */
export const cronRouter = express.Router();

export function derivedCronToken(): string {
  return createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('automation-restaurant-cron-v1').digest('hex');
}

function authorized(req: Request): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!given) return false;
  const candidates = [derivedCronToken(), env.CRON_SECRET].filter((s): s is string => !!s);
  return candidates.some((expected) => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

const JOBS: Record<string, () => Promise<void>> = {
  'low-stock': runLowStockSweepAllTenants,
  'recipe-cost': runRecipeCostSweepAllTenants,
  attendance: runAttendanceAutoAbsentSweepAllTenants,
};

async function handle(req: Request, res: Response) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const job = JOBS[String(req.params.job)];
  if (!job) return res.status(404).json({ error: 'unknown_job', jobs: Object.keys(JOBS) });
  const started = Date.now();
  try {
    await job();
    return res.json({ ok: true, job: req.params.job, ms: Date.now() - started });
  } catch (err) {
    console.error(`[cron] ${req.params.job} failed:`, err);
    return res.status(500).json({ ok: false, job: req.params.job, error: String((err as Error).message ?? err) });
  }
}

cronRouter.get('/:job', handle);
cronRouter.post('/:job', handle);
