import type { PlanRow, FeatureKey, PlanTier } from '@automation-restaurant/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const CP_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_ANON =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NTU0MzQsImV4cCI6MjEwNDUzMTQzNH0.aqDrwPKSEyZxeDrRLCncvbinLik2IWsZmUlz3RoIjnM';

export const DEFAULT_PLANS: PlanRow[] = [
  {
    id: 'abb2ce6e-2ca7-46c4-8287-cfd8b8e8ee85',
    tier: 'starter',
    name: 'Starter',
    blurb: 'For small restaurants and cafés.',
    priceMonthlyCents: 4900,
    priceAnnualCents: 3900,
    currency: 'usd',
    limits: { users: '5', tables: '20', support: 'Email', branches: '1' },
    highlights: ['POS & orders', 'QR table ordering', 'Tables & floor', 'Basic reports'],
    features: [],
    stripePriceIdMonthly: null,
    stripePriceIdAnnual: null,
    isActive: true,
    sortOrder: 0,
  },
  {
    id: '3cbb09da-5ce6-4551-846a-e066bb509b5b',
    tier: 'growth',
    name: 'Professional',
    blurb: 'For growing restaurants.',
    priceMonthlyCents: 12900,
    priceAnnualCents: 10300,
    currency: 'usd',
    limits: { users: '20', tables: 'Unlimited', support: 'Priority', branches: '1' },
    highlights: [
      'Everything in Starter',
      'Kitchen display + real-time',
      'Inventory & recipes',
      'Staff, customers, reservations',
    ],
    features: [
      'pos.multi_terminal',
      'kds.realtime',
      'inventory.recipe_deduction',
      'menu.branded',
    ] as FeatureKey[],
    stripePriceIdMonthly: null,
    stripePriceIdAnnual: null,
    isActive: true,
    sortOrder: 1,
  },
  {
    id: 'b84dffd6-ed35-483a-a205-504531a21d46',
    tier: 'enterprise',
    name: 'Enterprise',
    blurb: 'For multi-branch restaurant groups.',
    priceMonthlyCents: null,
    priceAnnualCents: null,
    currency: 'usd',
    limits: { users: 'Unlimited', tables: 'Unlimited', support: 'Dedicated', branches: 'Unlimited' },
    highlights: [
      'Everything in Professional',
      'Multi-branch management',
      'Accounting',
      'Custom branding',
    ],
    features: [
      'pos.multi_terminal',
      'kds.realtime',
      'kds.station_routing',
      'inventory.recipe_deduction',
      'branches.multi',
    ] as FeatureKey[],
    stripePriceIdMonthly: null,
    stripePriceIdAnnual: null,
    isActive: true,
    sortOrder: 2,
  },
];

type PlanDbRow = {
  id: string;
  tier: string;
  name: string;
  blurb: string | null;
  price_monthly_cents: number | null;
  price_annual_cents: number | null;
  currency: string;
  limits: Record<string, string>;
  highlights: string[];
  features: string[];
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  is_active: boolean;
  sort_order: number;
};

function toPlanRow(r: PlanDbRow): PlanRow {
  return {
    id: r.id,
    tier: r.tier as PlanTier,
    name: r.name,
    blurb: r.blurb,
    priceMonthlyCents: r.price_monthly_cents,
    priceAnnualCents: r.price_annual_cents,
    currency: r.currency,
    limits: r.limits ?? {},
    highlights: r.highlights ?? [],
    features: (r.features ?? []) as FeatureKey[],
    stripePriceIdMonthly: r.stripe_price_id_monthly,
    stripePriceIdAnnual: r.stripe_price_id_annual,
    isActive: r.is_active,
    sortOrder: r.sort_order,
  };
}

async function fetchPlans(): Promise<{ plans: PlanRow[]; billingConfigured: boolean }> {
  // 1. Try public API endpoint if not on default localhost or reachable
  if (API && !API.includes('localhost:4000')) {
    try {
      const res = await fetch(`${API}/api/public/plans`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { plans: PlanRow[]; billing_configured: boolean };
        if (body.plans?.length) {
          return { plans: body.plans, billingConfigured: body.billing_configured ?? false };
        }
      }
    } catch {
      // Fall through to direct Supabase fetch
    }
  }

  // 2. Query Supabase control-plane database directly
  try {
    const res = await fetch(
      `${CP_URL}/rest/v1/plans?select=*&is_active=eq.true&order=sort_order`,
      {
        headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as PlanDbRow[];
      if (Array.isArray(data) && data.length > 0) {
        return { plans: data.map(toPlanRow), billingConfigured: false };
      }
    }
  } catch {
    // Fall through to bundled defaults
  }

  // 3. Bundled standard plans fallback (guarantees pricing is NEVER blank)
  return { plans: DEFAULT_PLANS, billingConfigured: false };
}

export async function getActivePlans(): Promise<PlanRow[]> {
  return (await fetchPlans()).plans;
}

export async function getPlanByTier(tier: string): Promise<PlanRow | undefined> {
  const { plans } = await fetchPlans();
  return plans.find((p) => p.tier === tier);
}

export async function isBillingConfigured(): Promise<boolean> {
  return (await fetchPlans()).billingConfigured;
}
