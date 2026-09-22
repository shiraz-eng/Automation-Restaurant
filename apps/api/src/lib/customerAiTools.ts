import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The customer-facing sales/recommendation assistant's tool allowlist.
 *
 * Unlike the staff assistant (aiTools.ts), `tenant` here is always the
 * restaurant's own ANON-key client (routes/customerAi.ts, mirroring
 * routes/public.ts) — never service-role. Every read goes through the
 * SAME `guest_read` RLS policies the storefront itself uses, and the two
 * write-shaped tools (resolve_menu_selection, compare_deal_savings) never
 * mutate anything — they only recompute authoritative prices/eligibility
 * from real rows so the client can apply the result through its own
 * existing cart functions. No tool here ever trusts a client-supplied
 * price, name, or ranking — every number is read fresh from the DB.
 */
export type CustomerAiTool = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (tenant: SupabaseClient, args: Record<string, unknown>) => Promise<unknown>;
};

type CartLineIn = { variant_id?: string; deal_id?: string; qty?: number; modifier_option_ids?: string[] };

function asCartLines(v: unknown): CartLineIn[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (l && typeof l === 'object' ? (l as CartLineIn) : null))
    .filter((l): l is CartLineIn => !!l && (!!l.variant_id || !!l.deal_id) && (l.qty ?? 0) > 0);
}

// ── Best sellers / trending (spec §3-5): structured evidence, never an
// LLM-invented ranking. Mirrors aiTools.ts's topItems() aggregation
// pattern, but at variant granularity (so results carry real orderable
// IDs) and over the tenant's own anon client — order_lines/orders are
// guest_read (see schema.sql), so this needs no new grant.
type LineAgg = { qty: number; revenue_cents: number };

async function aggregateLines(
  tenant: SupabaseClient,
  sinceIso: string,
): Promise<Map<string, LineAgg & { name: string }>> {
  const { data } = await tenant
    .from('order_lines')
    .select('variant_id, name_snapshot, qty, line_total_cents, deal_id, orders!inner(created_at, status)')
    .gte('orders.created_at', sinceIso)
    .neq('orders.status', 'void')
    .is('deal_id', null); // combo lines are counted separately by deal popularity, not double-counted per item
  const acc = new Map<string, LineAgg & { name: string }>();
  for (const l of (data ?? []) as { variant_id: string | null; name_snapshot: string; qty: number; line_total_cents: number }[]) {
    if (!l.variant_id) continue;
    const cur = acc.get(l.variant_id) ?? { qty: 0, revenue_cents: 0, name: l.name_snapshot };
    cur.qty += l.qty ?? 0;
    cur.revenue_cents += l.line_total_cents ?? 0;
    acc.set(l.variant_id, cur);
  }
  return acc;
}

// The recipe-driven availability engine (tenant-migrations/0052) — the ONE
// authoritative "can we actually make this right now" signal. Read via the
// same guest-readable product_availability table the storefront itself
// uses (guest_read policy, no reason/bottleneck exposed here — spec §26/
// §27: customer-facing stays a plain boolean). Absence of a row for an
// item means the engine doesn't track it, so the manual toggle is final.
async function computedAvailableItems(tenant: SupabaseClient): Promise<Map<string, boolean>> {
  const { data } = await tenant.from('product_availability').select('menu_item_id, variant_id, status');
  const rows = (data ?? []) as { menu_item_id: string; variant_id: string | null; status: string }[];
  const out = new Map<string, boolean>(); // key: menu_item_id or `${menu_item_id}:${variant_id}`
  const byItem = new Map<string, typeof rows>();
  for (const r of rows) {
    out.set(`${r.menu_item_id}:${r.variant_id ?? ''}`, r.status !== 'unavailable');
    const cur = byItem.get(r.menu_item_id) ?? [];
    cur.push(r);
    byItem.set(r.menu_item_id, cur);
  }
  for (const [itemId, itemRows] of byItem) out.set(itemId, !itemRows.every((r) => r.status === 'unavailable'));
  return out;
}
function computedAvailable(map: Map<string, boolean>, itemId: string, variantId?: string | null): boolean {
  const key = variantId != null ? `${itemId}:${variantId}` : undefined;
  if (key && map.has(key)) return map.get(key)!;
  return map.get(itemId) ?? true; // untracked => fall back to manual signal only
}

async function availableVariantMeta(tenant: SupabaseClient, variantIds: string[]) {
  if (variantIds.length === 0) return new Map<string, { name: string; item_id: string; category_id: string | null; available: boolean }>();
  const [{ data }, computed] = await Promise.all([
    tenant
      .from('menu_variants')
      .select('id, name, is_available, track_availability, available_qty, menu_items(id, name, category_id, is_available)')
      .in('id', variantIds),
    computedAvailableItems(tenant),
  ]);
  const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
  const out = new Map<string, { name: string; item_id: string; category_id: string | null; available: boolean }>();
  for (const v of (data ?? []) as {
    id: string; name: string; is_available: boolean; track_availability: boolean; available_qty: number;
    menu_items: { id: string; name: string; category_id: string | null; is_available: boolean } | { id: string; name: string; category_id: string | null; is_available: boolean }[] | null;
  }[]) {
    const item = one(v.menu_items);
    const available =
      !!item?.is_available && v.is_available && (!v.track_availability || v.available_qty > 0) && computedAvailable(computed, item?.id ?? '', v.id);
    out.set(v.id, {
      name: item ? (v.name === 'Regular' ? item.name : `${item.name} · ${v.name}`) : v.name,
      item_id: item?.id ?? '',
      category_id: item?.category_id ?? null,
      available,
    });
  }
  return out;
}

const getBestSellers: CustomerAiTool = {
  name: 'get_best_sellers',
  description:
    "Real best-selling items over a recent window, ranked by units actually sold (completed orders only). Use for 'what's popular', 'best sellers', 'what do people order most'. Never invent a ranking — if this returns few/no items, say the data is too thin rather than guessing.",
  input_schema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Lookback window in days (1-90). Default 7.' },
      limit: { type: 'number', description: 'Max items to return (1-12). Default 6.' },
    },
  },
  async run(tenant, args) {
    const days = Math.min(90, Math.max(1, Number(args.days) || 7));
    const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const agg = await aggregateLines(tenant, since);
    const meta = await availableVariantMeta(tenant, [...agg.keys()]);
    const totalOrders = [...agg.values()].reduce((s, v) => s + v.qty, 0);
    const ranked = [...agg.entries()]
      .map(([variant_id, v]) => ({ variant_id, ...v, ...meta.get(variant_id) }))
      .filter((r) => r.available !== false)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit)
      .map((r, i) => ({
        recommendation_type: 'best_seller' as const,
        entity_id: r.variant_id,
        item_id: r.item_id,
        name: r.name,
        category_id: r.category_id,
        rank: i + 1,
        sales_count: r.qty,
        revenue_cents: r.revenue_cents,
        period_days: days,
        availability: true,
        confidence: totalOrders >= 20 ? 'high' : totalOrders >= 5 ? 'medium' : 'low',
      }));
    return {
      period_days: days,
      sample_size_units: totalOrders,
      items: ranked,
      note: ranked.length === 0 ? 'No completed-order data in this window — cannot claim a best seller yet.' : null,
    };
  },
};

const getTrendingItems: CustomerAiTool = {
  name: 'get_trending_items',
  description:
    "Items whose recent daily sales pace is meaningfully above their own prior baseline — a real velocity comparison, not a guess. Use for 'what's trending'. Distinct from best_seller (that's total volume, this is a RATE increase).",
  input_schema: {
    type: 'object',
    properties: {
      recent_days: { type: 'number', description: 'Recent window in days. Default 2.' },
      baseline_days: { type: 'number', description: 'Prior baseline window in days, immediately before the recent window. Default 12.' },
      limit: { type: 'number' },
    },
  },
  async run(tenant, args) {
    const recentDays = Math.min(14, Math.max(1, Number(args.recent_days) || 2));
    const baselineDays = Math.min(60, Math.max(3, Number(args.baseline_days) || 12));
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 6));
    const now = Date.now();
    const recentSince = new Date(now - recentDays * 86400000).toISOString();
    const baselineSince = new Date(now - (recentDays + baselineDays) * 86400000).toISOString();
    const [recentAgg, fullAgg] = await Promise.all([
      aggregateLines(tenant, recentSince),
      aggregateLines(tenant, baselineSince),
    ]);
    const variantIds = [...new Set([...recentAgg.keys(), ...fullAgg.keys()])];
    const meta = await availableVariantMeta(tenant, variantIds);
    const recentRate = (id: string) => (recentAgg.get(id)?.qty ?? 0) / recentDays;
    const baselineRate = (id: string) => Math.max(0, (fullAgg.get(id)?.qty ?? 0) - (recentAgg.get(id)?.qty ?? 0)) / baselineDays;
    const ranked = variantIds
      .map((id) => ({ variant_id: id, recent: recentRate(id), baseline: baselineRate(id), ...meta.get(id) }))
      .filter((r) => r.available !== false && r.recent > 0 && (recentAgg.get(r.variant_id)?.qty ?? 0) >= 3)
      .map((r) => ({ ...r, ratio: r.baseline > 0 ? r.recent / r.baseline : r.recent >= 1 ? 3 : 0 }))
      .filter((r) => r.ratio >= 1.3)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, limit)
      .map((r, i) => ({
        recommendation_type: 'trending' as const,
        entity_id: r.variant_id,
        item_id: r.item_id,
        name: r.name,
        category_id: r.category_id,
        rank: i + 1,
        sales_count: recentAgg.get(r.variant_id)?.qty ?? 0,
        velocity_ratio: Math.round(r.ratio * 100) / 100,
        period: `last ${recentDays}d vs prior ${baselineDays}d`,
        availability: true,
        confidence: (recentAgg.get(r.variant_id)?.qty ?? 0) >= 6 ? 'medium' : 'low',
      }));
    return { items: ranked, note: ranked.length === 0 ? 'No item is trending meaningfully above its own baseline right now.' : null };
  },
};

const getBestValueItems: CustomerAiTool = {
  name: 'get_best_value_items',
  description:
    "The lowest-priced available items (optionally within a category) — a price-based 'best value' metric, distinct from best_seller/trending/highest-rated. Never call this data a 'best seller' or a rating.",
  input_schema: {
    type: 'object',
    properties: {
      category_id: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  async run(tenant, args) {
    const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
    let q = tenant
      .from('menu_variants')
      .select('id, name, price_cents, is_available, track_availability, available_qty, menu_items!inner(id, name, category_id, is_available)')
      .eq('is_available', true)
      .eq('menu_items.is_available', true);
    if (typeof args.category_id === 'string' && args.category_id) q = q.eq('menu_items.category_id', args.category_id);
    const [{ data }, computed] = await Promise.all([q, computedAvailableItems(tenant)]);
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
    const rows = ((data ?? []) as {
      id: string; name: string; price_cents: number; track_availability: boolean; available_qty: number;
      menu_items: { id: string; name: string; category_id: string | null } | { id: string; name: string; category_id: string | null }[];
    }[])
      .filter((v) => (!v.track_availability || v.available_qty > 0) && computedAvailable(computed, one(v.menu_items)?.id ?? '', v.id))
      .map((v) => {
        const item = one(v.menu_items);
        return {
          entity_id: v.id,
          item_id: item?.id ?? '',
          name: item ? (v.name === 'Regular' ? item.name : `${item.name} · ${v.name}`) : v.name,
          category_id: item?.category_id ?? null,
          price_cents: v.price_cents,
        };
      })
      .sort((a, b) => a.price_cents - b.price_cents)
      .slice(0, limit)
      .map((r, i) => ({ recommendation_type: 'best_value' as const, rank: i + 1, availability: true, confidence: 'high' as const, ...r }));
    return { items: rows };
  },
};

const getActiveDeals: CustomerAiTool = {
  name: 'get_active_deals',
  description: "Currently available combos/deals with their real fixed price. Use for 'what deals do you have'.",
  input_schema: { type: 'object', properties: {} },
  async run(tenant) {
    const { data } = await tenant
      .from('deals')
      .select(
        'id, name, description, price_cents, track_availability, available_qty, deal_components(qty, menu_item_id, variant_id, menu_items(name), menu_variants(name))',
      )
      .eq('is_available', true)
      .order('sort_order');
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
    const deals = ((data ?? []) as {
      id: string; name: string; description: string | null; price_cents: number; track_availability: boolean; available_qty: number;
      deal_components: { qty: number; menu_items: { name: string } | { name: string }[] | null; menu_variants: { name: string } | { name: string }[] | null }[];
    }[])
      .filter((d) => !d.track_availability || d.available_qty > 0)
      .map((d) => ({
        deal_id: d.id,
        name: d.name,
        description: d.description,
        price_cents: d.price_cents,
        includes: d.deal_components.map((c) => {
          const v = one(c.menu_variants);
          const it = one(c.menu_items);
          return { qty: c.qty, label: v?.name || it?.name || 'item' };
        }),
      }));
    return { deals };
  },
};

// ── Deal savings comparison (spec §6): the AI must never compute this.
// Re-derives individual-item and deal totals straight from current DB
// prices for exactly the lines the customer's cart actually has, then
// returns the comparison for the model to explain in words only.
const compareDealSavings: CustomerAiTool = {
  name: 'compare_deal_savings',
  description:
    "Checks the customer's ACTUAL current cart (the server already knows its exact contents — you never need to guess or supply it) against every currently-active deal, returning any deal it already qualifies for (or is exactly one item away from), with the REAL individual total, deal total, and savings in cents. Call this any time the customer asks about deals/savings, or right after they mention adding something — you must present these exact numbers, never calculate or restate a different figure. Always let the customer choose to switch; never say it's already been applied.",
  input_schema: { type: 'object', properties: {} },
  async run(tenant, args) {
    const lines = asCartLines(args.cart_lines).filter((l) => l.variant_id);
    if (lines.length === 0) return { matches: [], note: 'Cart is empty or has no plain (non-deal) items to match against a combo.' };

    const [{ data: variants }, { data: deals }] = await Promise.all([
      tenant
        .from('menu_variants')
        .select('id, price_cents, menu_item_id')
        .in('id', lines.map((l) => l.variant_id as string)),
      tenant
        .from('deals')
        .select(
          'id, name, price_cents, deal_components(qty, menu_item_id, variant_id, menu_items(name, menu_variants(name, price_cents, sort_order)), menu_variants(name, price_cents))',
        )
        .eq('is_available', true),
    ]);
    const priceByVariant = new Map((variants ?? []).map((v: { id: string; price_cents: number; menu_item_id: string }) => [v.id, v]));
    const pool = new Map<string, number>(); // variant_id -> qty available to match
    for (const l of lines) pool.set(l.variant_id!, (pool.get(l.variant_id!) ?? 0) + (l.qty ?? 0));

    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
    const matches: unknown[] = [];
    for (const deal of (deals ?? []) as {
      id: string; name: string; price_cents: number;
      deal_components: {
        qty: number; variant_id: string | null; menu_item_id: string | null;
        menu_variants: { name: string; price_cents: number } | { name: string; price_cents: number }[] | null;
        menu_items: { name: string; menu_variants: { name: string; price_cents: number; sort_order: number }[] } | { name: string; menu_variants: { name: string; price_cents: number; sort_order: number }[] }[] | null;
      }[];
    }[]) {
      const poolCopy = new Map(pool);
      let individualTotal = 0;
      let unmet = 0;
      let missingLabel: string | null = null;
      for (const c of deal.deal_components) {
        const v = one(c.menu_variants);
        const it = one(c.menu_items);
        // A component pinned to a specific variant prices from that variant;
        // an item-only component (place_order's "any variant of this item"
        // case) prices from that item's own default (lowest sort_order)
        // variant — menu_items.price_cents is an unused fallback, never the
        // real price (schema.sql: "real price on variant").
        const defaultVariant = it?.menu_variants
          ? [...it.menu_variants].sort((a, b) => a.sort_order - b.sort_order)[0]
          : undefined;
        const unit = v?.price_cents ?? defaultVariant?.price_cents ?? 0;
        individualTotal += unit * c.qty;
        let have = 0;
        if (c.variant_id) {
          have = Math.min(poolCopy.get(c.variant_id) ?? 0, c.qty);
          poolCopy.set(c.variant_id, (poolCopy.get(c.variant_id) ?? 0) - have);
        } else if (c.menu_item_id) {
          let remaining = c.qty;
          for (const [vid, qty] of poolCopy) {
            if (remaining <= 0) break;
            if (priceByVariant.get(vid)?.menu_item_id !== c.menu_item_id || qty <= 0) continue;
            const take = Math.min(qty, remaining);
            poolCopy.set(vid, qty - take);
            remaining -= take;
          }
          have = c.qty - remaining;
        }
        if (have < c.qty) {
          unmet += 1;
          missingLabel = v?.name || it?.name || 'an item';
        }
      }
      const savings = individualTotal - deal.price_cents;
      if (savings <= 0) continue;
      if (unmet === 0) {
        matches.push({
          deal_id: deal.id,
          deal_name: deal.name,
          status: 'eligible_now',
          individual_total_cents: individualTotal,
          deal_total_cents: deal.price_cents,
          savings_cents: savings,
        });
      } else if (unmet === 1) {
        matches.push({
          deal_id: deal.id,
          deal_name: deal.name,
          status: 'one_item_away',
          missing: missingLabel,
          individual_total_cents: individualTotal,
          deal_total_cents: deal.price_cents,
          savings_cents: savings,
        });
      }
    }
    return { matches, note: matches.length === 0 ? 'No active deal is a better price than this cart right now.' : null };
  },
};

// ── Resolve + price a described selection (spec §8): the ONLY way item
// names/variant/modifier text becomes real IDs and a real price. The
// client applies the result through its OWN existing add-to-cart
// function — this tool never mutates anything.
const resolveMenuSelection: CustomerAiTool = {
  name: 'resolve_menu_selection',
  description:
    "Resolves a customer's plain-language item request (e.g. 'Chicken Burger with extra cheese, large') into real, orderable IDs with the true current price and availability. Always call this before telling the customer you've added or priced something. If multiple items/variants could match, it returns candidates — ask the customer to pick rather than guessing.",
  input_schema: {
    type: 'object',
    properties: {
      item_name: { type: 'string' },
      variant_name: { type: 'string', description: 'Optional size/variant, e.g. "Large".' },
      modifier_names: { type: 'array', items: { type: 'string' }, description: 'Optional modifier/add-on names, e.g. ["Extra Cheese"].' },
    },
    required: ['item_name'],
  },
  async run(tenant, args) {
    const itemName = String(args.item_name ?? '').trim().toLowerCase();
    if (!itemName) return { matches: [] };
    const [{ data: items }, computed] = await Promise.all([
      tenant
        .from('menu_items')
        .select('id, name, price_cents, is_available, menu_variants(id, name, price_cents, is_available, track_availability, available_qty), modifier_groups(id, name, modifier_options(id, name, price_cents, is_available))')
        .eq('is_available', true),
      computedAvailableItems(tenant),
    ]);
    const candidates = ((items ?? []) as {
      id: string; name: string; price_cents: number; is_available: boolean;
      menu_variants: { id: string; name: string; price_cents: number; is_available: boolean; track_availability: boolean; available_qty: number }[];
      modifier_groups: { id: string; name: string; modifier_options: { id: string; name: string; price_cents: number; is_available: boolean }[] }[];
    }[]).filter((it) => it.name.toLowerCase().includes(itemName) || itemName.includes(it.name.toLowerCase()));

    if (candidates.length === 0) return { matches: [], note: `No menu item matches "${args.item_name}".` };

    const variantName = typeof args.variant_name === 'string' ? args.variant_name.trim().toLowerCase() : '';
    const modNames = Array.isArray(args.modifier_names) ? args.modifier_names.map((m) => String(m).trim().toLowerCase()) : [];

    const results = candidates.map((it) => {
      const variants = it.menu_variants.filter(
        (v) => v.is_available && (!v.track_availability || v.available_qty > 0) && computedAvailable(computed, it.id, v.id),
      );
      const variant = (variantName ? variants.find((v) => v.name.toLowerCase().includes(variantName)) : null) ?? variants[0] ?? null;
      const allOptions = it.modifier_groups.flatMap((g) => g.modifier_options.map((o) => ({ ...o, group: g.name })));
      const resolvedMods = modNames
        .map((mn) => allOptions.find((o) => o.is_available && o.name.toLowerCase().includes(mn)))
        .filter((o): o is (typeof allOptions)[number] => !!o);
      const unresolvedMods = modNames.filter(
        (mn) => !allOptions.some((o) => o.is_available && o.name.toLowerCase().includes(mn)),
      );
      const basePrice = variant?.price_cents ?? it.price_cents;
      const modsTotal = resolvedMods.reduce((s, o) => s + o.price_cents, 0);
      return {
        menu_item_id: it.id,
        item_name: it.name,
        variant_id: variant?.id ?? null,
        variant_name: variant?.name ?? null,
        available: !!variant,
        available_variants: variants.map((v) => v.name),
        modifier_option_ids: resolvedMods.map((o) => o.id),
        resolved_modifiers: resolvedMods.map((o) => ({ name: o.name, price_cents: o.price_cents })),
        unresolved_modifier_names: unresolvedMods,
        unit_price_cents: variant ? basePrice + modsTotal : null,
      };
    });
    return { matches: results };
  },
};

// ── Budget / build-my-order (spec §7): a reviewable proposal only, built
// from real prices — greedy fit within budget, preferring an eligible
// deal when one is cheaper than its components, else best-seller-ish
// popular items first (falls back to price order if there isn't enough
// sales data yet).
const buildBudgetOrder: CustomerAiTool = {
  name: 'build_budget_order',
  description:
    "Proposes a real, currently-orderable combination of items (and a deal, if one fits and saves money) that fits within a budget — for requests like 'something under Rs 1000' or 'feed 2 people for Rs 2000'. This is a PROPOSAL to review with the customer, never something already added to their cart. Always present it as a suggestion they can accept, adjust, or reject.",
  input_schema: {
    type: 'object',
    properties: {
      budget_cents: { type: 'number' },
      people: { type: 'number', description: 'Roughly how many people this should feed. Default 1.' },
    },
    required: ['budget_cents'],
  },
  async run(tenant, args) {
    const budget = Math.max(0, Math.floor(Number(args.budget_cents) || 0));
    const people = Math.max(1, Math.min(20, Math.floor(Number(args.people) || 1)));
    if (budget <= 0) return { proposal: null, note: 'Need a positive budget to build a proposal.' };

    const since = new Date(Date.now() - 14 * 86400000).toISOString();
    const [agg, dealsRes, variantsRes, computed] = await Promise.all([
      aggregateLines(tenant, since),
      tenant
        .from('deals')
        .select('id, name, price_cents, track_availability, available_qty, deal_components(qty, menu_item_id, variant_id)')
        .eq('is_available', true),
      tenant
        .from('menu_variants')
        .select('id, name, price_cents, is_available, track_availability, available_qty, menu_items!inner(id, name, category_id, is_available)')
        .eq('is_available', true)
        .eq('menu_items.is_available', true),
      computedAvailableItems(tenant),
    ]);
    const variantRows = variantsRes.data;
    const one = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
    const variants = ((variantRows ?? []) as {
      id: string; name: string; price_cents: number; track_availability: boolean; available_qty: number;
      menu_items: { id: string; name: string; category_id: string | null } | { id: string; name: string; category_id: string | null }[];
    }[])
      .filter((v) => (!v.track_availability || v.available_qty > 0) && computedAvailable(computed, one(v.menu_items)?.id ?? '', v.id))
      .map((v) => {
        const item = one(v.menu_items);
        return {
          variant_id: v.id,
          item_id: item?.id ?? '',
          category_id: item?.category_id ?? null,
          name: item ? (v.name === 'Regular' ? item.name : `${item.name} · ${v.name}`) : v.name,
          price_cents: v.price_cents,
          popularity: agg.get(v.id)?.qty ?? 0,
        };
      })
      .sort((a, b) => b.popularity - a.popularity || a.price_cents - b.price_cents);

    const perPersonTarget = budget / people;
    const eligibleDeals = ((dealsRes.data ?? []) as { id: string; name: string; price_cents: number; track_availability: boolean; available_qty: number }[])
      .filter((d) => (!d.track_availability || d.available_qty > 0) && d.price_cents <= budget)
      .sort((a, b) => b.price_cents - a.price_cents); // richest single deal that still fits

    const items: { variant_id: string; name: string; qty: number; unit_price_cents: number }[] = [];
    let dealUsed: { deal_id: string; name: string; price_cents: number; qty: number } | null = null;

    // A deal already bundles several items into one fixed price — stacking
    // separately-picked items ALONGSIDE it would double-serve the same
    // food and silently blow past the budget. So this picks ONE path, not
    // both: prefer as many of the single best-fitting deal as the budget
    // allows (up to `people`), and only fall back to individually-picked
    // items when no deal fits at all. price_cents stays PER UNIT — qty is
    // separate — so the client can add exactly `qty` copies and display
    // the line the same way any other quantified line is shown.
    const bestDeal = eligibleDeals[0];
    if (bestDeal) {
      const count = Math.max(1, Math.min(people, Math.floor(budget / bestDeal.price_cents)));
      dealUsed = { deal_id: bestDeal.id, name: bestDeal.name, price_cents: bestDeal.price_cents, qty: count };
    } else {
      let remaining = budget;
      // Simple greedy: one popular main-ish item per person, then fill
      // with cheaper items until budget or variety runs out. Not a menu-
      // engineering optimizer — just a deterministic, price-true proposal.
      const picks = [...variants];
      let personSlots = people;
      while (personSlots > 0 && picks.length > 0) {
        const p = picks.find((v) => v.price_cents <= remaining);
        if (!p) break;
        items.push({ variant_id: p.variant_id, name: p.name, qty: 1, unit_price_cents: p.price_cents });
        remaining -= p.price_cents;
        personSlots -= 1;
        // avoid immediately repeating the same item back-to-back when picking for multiple people
        picks.splice(picks.indexOf(p), 1);
        picks.push(p);
      }
      // Fill remaining budget with cheap add-ons if plenty is left.
      while (remaining > 0) {
        const p = variants.find((v) => v.price_cents <= remaining && !items.some((i) => i.variant_id === v.variant_id));
        if (!p) break;
        items.push({ variant_id: p.variant_id, name: p.name, qty: 1, unit_price_cents: p.price_cents });
        remaining -= p.price_cents;
        if (items.length >= people * 3) break; // keep the proposal reviewable, not a huge dump
      }
    }

    const subtotal = items.reduce((s, i) => s + i.unit_price_cents * i.qty, 0) + (dealUsed ? dealUsed.price_cents * dealUsed.qty : 0);
    return {
      proposal: items.length === 0 && !dealUsed ? null : { items, deal: dealUsed, subtotal_cents: subtotal, people, budget_cents: budget, per_person_target_cents: Math.round(perPersonTarget) },
      note: items.length === 0 && !dealUsed ? 'Nothing currently available fits that budget.' : 'Reviewable proposal only — nothing has been added to the cart.',
    };
  },
};

const getOrderStatus: CustomerAiTool = {
  name: 'get_order_status',
  description: "Look up a specific order's current status/total by its order ID (the customer has this from their receipt/tracking link).",
  input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  async run(tenant, args) {
    const orderId = String(args.order_id ?? '').trim();
    if (!orderId) return { found: false };
    const { data } = await tenant
      .from('orders')
      .select('id, order_number, status, subtotal_cents, tax_cents, total_cents, created_at, order_lines(name_snapshot, qty, line_total_cents)')
      .eq('id', orderId)
      .maybeSingle();
    if (!data) return { found: false };
    return { found: true, order: data };
  },
};

export const CUSTOMER_AI_TOOLS: CustomerAiTool[] = [
  getBestSellers,
  getTrendingItems,
  getBestValueItems,
  getActiveDeals,
  compareDealSavings,
  resolveMenuSelection,
  buildBudgetOrder,
  getOrderStatus,
];

export const CUSTOMER_SYSTEM_PROMPT = (restaurantName: string) => `You are the ordering assistant for ${restaurantName}, talking with a guest on the restaurant's own ordering page. Be warm, brief, and genuinely helpful — you are here to help them decide what to order, not to interrogate them.

Ground rules (never break these):
- You NEVER add anything to the cart, change a price, apply a deal, or place an order yourself. You only recommend, explain, and propose. The customer always makes the final tap/click themselves in the UI.
- Every price, total, saving, ranking, or availability claim you make MUST come from a tool result you just received. Never estimate, round creatively, or restate a different number than the tool returned.
- Availability (in resolve_menu_selection and every recommendation tool) already reflects the kitchen's real, live producible stock, not just whether an item is listed on the menu. If asked WHY something is unavailable, just say it's "currently unavailable" or "temporarily out of stock" — you don't have and should never invent a specific ingredient-level reason; that detail is for staff, not guests.
- "Best seller" (real sales volume), "trending" (a recent pace increase), "best value" (lowest price), and a deal's "savings" are different things — use the exact word the matching tool result uses, never swap them.
- There is no per-item star rating in this system — never claim an item is "highly rated" or invent a rating.
- There is no customer account/order-history lookup in this system — if asked to "order my usual" or reference a past visit, say you don't have that and offer to help build a fresh order instead.
- If a tool returns no data or a "note" saying data is thin, say so plainly rather than filling the gap with a guess.
- You do NOT reliably know what's already in the customer's cart from conversation alone — items they added directly on the page (not through you) never get mentioned to you. Whenever the customer asks about deals/savings, or after they mention adding or having something, call compare_deal_savings — it always checks their real, current cart server-side, so you never need to (and never can) supply its contents yourself.
- When comparing deal savings, always end by asking whether they'd like to switch — never say a deal has been applied.
- When resolving an item the customer described, if resolve_menu_selection returns multiple candidates or unresolved modifiers, ask a short clarifying question instead of guessing which one they meant.
- Keep replies short — this is a chat widget on a phone screen, not an email.`;
