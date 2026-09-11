import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../supabase';
import { env } from '../env';

export const publicRouter = express.Router();

const TAX_RATE_BPS = 800;

// Storefront is served cross-origin from the web app in dev.
publicRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// slug -> ANON client for that restaurant's dedicated project. Public endpoints
// (menu read, place_order, promo preview) run with the anon key only: menu rows
// are guest-readable by RLS and the mutating calls are SECURITY DEFINER RPCs
// granted to anon. The platform never needs the tenant's admin key here.
const clientCache = new Map<string, SupabaseClient>();

async function tenantClientForSlug(slug: string): Promise<SupabaseClient | null> {
  const cached = clientCache.get(slug);
  if (cached) return cached;

  const { data } = await supabaseAdmin
    .from('tenant_projects')
    .select('project_url, anon_key, tenants!inner(slug, status)')
    .eq('tenants.slug', slug)
    .maybeSingle();

  const row = data as
    | { project_url: string; anon_key: string; tenants: { status: string } }
    | null;
  if (!row || row.tenants.status !== 'active' || !row.anon_key) return null;

  const client = createClient(row.project_url, row.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  clientCache.set(slug, client);
  return client;
}

publicRouter.get('/menu/:slug', async (req: Request, res: Response) => {
  const slug = req.params.slug ?? '';
  const tenant = slug ? await tenantClientForSlug(slug) : null;
  if (!tenant) return res.status(404).json({ error: 'restaurant_not_found' });

  const [{ data: categories }, { data: items }, { data: deals }] = await Promise.all([
    tenant.from('menu_categories').select('id, name, sort_order').order('sort_order'),
    tenant
      .from('menu_items')
      .select(
        'id, name, description, price_cents, category_id, image_url, menu_variants(id, name, price_cents, sku, is_available, track_availability, available_qty, sort_order), modifier_groups(id, name, kind, min_select, max_select, sort_order, modifier_options(id, name, price_cents, is_available, sort_order))',
      )
      .eq('is_available', true)
      .order('name'),
    tenant
      .from('deals')
      .select(
        'id, name, description, image_url, price_cents, sort_order, deal_components(qty, menu_item_id, variant_id, menu_items(name, price_cents), menu_variants(name, price_cents)), deal_option_groups(id, name, min_select, max_select, sort_order, deal_option_items(id, menu_item_id, variant_id, qty, price_adjustment_cents, is_default, sort_order, menu_items(name, is_available), menu_variants(name, is_available, track_availability, available_qty)))',
      )
      .eq('is_available', true)
      .order('sort_order'),
  ]);

  // Drop unavailable/out-of-stock variants; keep only items that still have one.
  // Same for modifier options — a disabled option never reaches the storefront.
  const cleaned = (items ?? [])
    .map((it: Record<string, unknown>) => ({
      ...it,
      menu_variants: ((it.menu_variants as Array<Record<string, unknown>>) ?? [])
        .filter((v) => v.is_available && (!v.track_availability || (v.available_qty as number) > 0))
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
      modifier_groups: ((it.modifier_groups as Array<Record<string, unknown>>) ?? [])
        .map(
          (g): Record<string, unknown> => ({
            ...g,
            modifier_options: ((g.modifier_options as Array<Record<string, unknown>>) ?? [])
              .filter((o) => o.is_available)
              .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
          }),
        )
        .filter((g) => (g.modifier_options as unknown[]).length > 0)
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
    }))
    .filter((it) => (it.menu_variants as unknown[]).length > 0);

  // Supabase embeds a to-one relation as an object (or an array of one on
  // some join shapes) — normalize to a single object/null either way.
  const one = <T>(x: T | T[] | null | undefined): T | null =>
    Array.isArray(x) ? (x[0] ?? null) : (x ?? null);

  // Deals: drop Build-Your-Own option items whose underlying menu item/
  // variant is no longer available (mirrors the modifier-option cleaning
  // above), then drop any group left with zero selectable options — a
  // required group with nothing to pick would strand the customer.
  const cleanedDeals = (deals ?? []).map((d: Record<string, unknown>) => ({
    ...d,
    deal_option_groups: ((d.deal_option_groups as Array<Record<string, unknown>>) ?? [])
      .map((g): Record<string, unknown> => ({
        ...g,
        deal_option_items: ((g.deal_option_items as Array<Record<string, unknown>>) ?? [])
          .filter((oi) => {
            const variant = one(oi.menu_variants as Record<string, unknown> | Record<string, unknown>[] | null);
            const item = one(oi.menu_items as Record<string, unknown> | Record<string, unknown>[] | null);
            if (oi.variant_id) {
              return (
                !!variant &&
                variant.is_available &&
                (!variant.track_availability || (variant.available_qty as number) > 0)
              );
            }
            return !!item && item.is_available;
          })
          // Keep just the display name from each embed — the storefront
          // needs "Chicken Burger · Large" the same way deal_components does
          // above; availability flags already did their job in the filter.
          .map((oi): Record<string, unknown> => ({
            ...oi,
            menu_items: (() => {
              const it = one(oi.menu_items as Record<string, unknown> | Record<string, unknown>[] | null);
              return it ? { name: it.name } : null;
            })(),
            menu_variants: (() => {
              const v = one(oi.menu_variants as Record<string, unknown> | Record<string, unknown>[] | null);
              return v ? { name: v.name } : null;
            })(),
          }))
          .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
      }))
      .filter((g) => (g.deal_option_items as unknown[]).length > 0)
      .sort((a, b) => (a.sort_order as number) - (b.sort_order as number)),
  }));

  res.json({ categories: categories ?? [], items: cleaned, deals: cleanedDeals });
});

// Storefront promo-code preview: validate a code against a subtotal without
// placing anything. place_order still re-checks on submit — this is display only.
publicRouter.get('/promo/:slug', async (req: Request, res: Response) => {
  const slug = req.params.slug ?? '';
  const code = String(req.query.code ?? '').trim();
  const subtotal = Number.parseInt(String(req.query.subtotal ?? ''), 10);
  if (!code || !Number.isFinite(subtotal) || subtotal < 0) {
    return res.status(422).json({ error: 'invalid_request' });
  }
  const tenant = await tenantClientForSlug(slug);
  if (!tenant) return res.status(404).json({ error: 'restaurant_not_found' });

  const { data, error } = await tenant.rpc('promo_discount', {
    p_code: code,
    p_subtotal_cents: subtotal,
  });
  if (error) return res.status(400).json({ error: 'promo_check_failed' });
  const discount = typeof data === 'number' ? data : 0;
  res.json({ valid: discount > 0, discount_cents: discount });
});

const orderSchema = z.object({
  slug: z.string().min(1),
  table: z.string().trim().max(40).optional(),
  guest_name: z.string().trim().max(80).optional(),
  channel: z.enum(['dine_in', 'takeaway', 'delivery']).default('dine_in'),
  promo_code: z.string().trim().min(1).max(40).optional(),
  customer_note: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        menu_item_id: z.string().uuid().optional(),
        variant_id: z.string().uuid().optional(),
        deal_id: z.string().uuid().optional(),
        qty: z.number().int().positive().max(99),
        note: z.string().trim().max(500).optional(),
        // Option IDs only — place_order() re-prices and re-validates every
        // one of them server-side. Never trust a client-supplied price/name.
        modifier_option_ids: z.array(z.string().uuid()).max(20).optional(),
        // Build-Your-Own-Combo selections (deal_option_items IDs) — same
        // re-price/re-validate-server-side contract as modifier_option_ids.
        deal_option_ids: z.array(z.string().uuid()).max(20).optional(),
      }),
    )
    .min(1)
    .max(50)
    .refine((ls) => ls.every((l) => l.menu_item_id || l.variant_id || l.deal_id), {
      message: 'each line needs menu_item_id, variant_id or deal_id',
    }),
});

publicRouter.post('/orders', express.json(), async (req: Request, res: Response) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const { slug, table, guest_name, channel, promo_code, customer_note, lines } = parsed.data;

  const tenant = await tenantClientForSlug(slug);
  if (!tenant) return res.status(404).json({ error: 'restaurant_not_found' });

  // place_order re-validates the code against the live promotion server-side and
  // computes the discount itself — the client can't dictate a price. Notes are
  // stored as untrusted plain text.
  const { data, error } = await tenant.rpc('place_order', {
    p_channel: channel,
    p_table_label: table ?? null,
    p_customer_name: guest_name ?? null,
    p_tax_rate_bps: TAX_RATE_BPS,
    p_lines: lines,
    p_promo_code: promo_code ?? null,
    p_customer_note: customer_note ?? null,
  });
  if (error) {
    return res.status(400).json({ error: 'order_failed', message: error.message });
  }

  const row = Array.isArray(data) ? data[0] : data;
  res.status(201).json({
    order_id: row.order_id,
    order_number: row.order_number,
    subtotal_cents: row.subtotal_cents,
    discount_cents: row.discount_cents,
    total_cents: row.total_cents,
    promo_applied: (row.discount_cents ?? 0) > 0,
  });
});

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email(),
  restaurant: z.string().trim().max(160).optional(),
  message: z.string().trim().min(1).max(4000),
});

publicRouter.post('/contact', express.json(), async (req: Request, res: Response) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(422)
      .json({ error: 'invalid_request', details: parsed.error.flatten().fieldErrors });
  }
  const { error } = await supabaseAdmin.from('contact_messages').insert({
    name: parsed.data.name,
    email: parsed.data.email,
    restaurant: parsed.data.restaurant ?? null,
    message: parsed.data.message,
  });
  if (error) return res.status(500).json({ error: 'save_failed' });
  res.status(201).json({ ok: true });
});
