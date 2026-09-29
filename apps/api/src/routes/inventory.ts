import express, { type Request, type Response, type NextFunction } from 'express';
import { supabaseAdmin } from '../supabase';
import { isAllowedOrigin } from '../env';
import { requirePortalPerm } from '../middleware/portalAuth';
import { runLowStockSweepForTenant } from '../lib/lowStockAutomation';

export const inventoryRouter = express.Router();

inventoryRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/**
 * POST /api/inventory/low-stock/sweep
 * Triggers an immediate, on-demand sweep for low-stock supplier emails.
 * Accessible to portal users with stock.view permission.
 */
inventoryRouter.post('/low-stock/sweep', express.json(), requirePortalPerm('stock.view'), async (req: Request, res: Response) => {
  const slug = req.tenant?.slug || (req.body?.slug as string);
  if (!slug) {
    return res.status(400).json({ error: 'missing_slug', message: 'Restaurant slug is required.' });
  }

  const { data: tenant } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle();
  if (!tenant) {
    return res.status(404).json({ error: 'restaurant_not_found', message: 'Restaurant not found.' });
  }

  try {
    const result = await runLowStockSweepForTenant(tenant.id, { force: true });
    return res.json({
      ok: true,
      attempted: result.attempted,
      sent: result.sent,
      message: result.message,
    });
  } catch (err) {
    console.error(`[inventory] low stock sweep error for ${slug}:`, err);
    return res.status(500).json({
      ok: false,
      error: 'sweep_failed',
      message: String((err as Error).message ?? err),
    });
  }
});
