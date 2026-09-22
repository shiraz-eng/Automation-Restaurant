import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import { getActivePlans } from './plans';
import { stripe, billingConfigured } from '../stripe';

/**
 * The SaaS-facing assistant's tool allowlist — billing/plan/account
 * questions for the restaurant OWNER managing their own subscription,
 * fully separate from the operational assistant (aiTools.ts) and the
 * customer ordering assistant (customerAiTools.ts).
 *
 * Every tool here runs ONLY against `admin` (the control-plane
 * supabaseAdmin client) and a `tenantId` resolved server-side from the
 * caller's verified session BEFORE any tool runs (routes/saasAi.ts) — never
 * a tenant-project client, never a client-supplied tenant id. That's the
 * actual security boundary: this assistant is architecturally incapable of
 * reaching orders/menu/inventory/staff/any-other-tenant's data, independent
 * of anything the model decides or any prompt wording below.
 */
export type SaasAiTool = {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (admin: SupabaseClient, tenantId: string, args: Record<string, unknown>) => Promise<unknown>;
};

const getMySubscription: SaasAiTool = {
  name: 'get_my_subscription',
  description: "This restaurant's own current plan, billing status, cycle, and next renewal date.",
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    const { data: sub } = await admin
      .from('subscriptions')
      .select('tier, billing_interval, status, current_period_end')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!sub) return { found: false };
    const plans = await getActivePlans();
    const plan = plans.find((p) => p.tier === sub.tier);
    return {
      found: true,
      plan_name: plan?.name ?? sub.tier,
      tier: sub.tier,
      billing_interval: sub.billing_interval,
      status: sub.status,
      current_period_end: sub.current_period_end,
      price_cents: sub.billing_interval === 'annual' ? (plan?.priceAnnualCents ?? null) : (plan?.priceMonthlyCents ?? null),
    };
  },
};

const listPlans: SaasAiTool = {
  name: 'list_plans',
  description: 'Every plan currently available (name, price, what it includes) — for comparing against what this restaurant has now, or answering "what would I get on X plan".',
  input_schema: { type: 'object', properties: {} },
  run: async () => {
    const plans = await getActivePlans();
    return {
      plans: plans.map((p) => ({
        tier: p.tier,
        name: p.name,
        blurb: p.blurb,
        price_monthly_cents: p.priceMonthlyCents,
        price_annual_cents: p.priceAnnualCents,
        highlights: p.highlights,
        limits: p.limits,
      })),
    };
  },
};

const getMyInvoices: SaasAiTool = {
  name: 'get_my_invoices',
  description: "This restaurant's own recent invoices from the payment provider (status, amount, date).",
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!billingConfigured) return { invoices: [], note: 'Billing is not connected to a live payment provider yet.' };
    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!sub?.stripe_customer_id) return { invoices: [], note: 'No billing account on file for this restaurant yet.' };
    const invoices = await stripe.invoices.list({ customer: sub.stripe_customer_id, limit: 10 });
    return {
      invoices: invoices.data.map((inv) => ({
        status: inv.status,
        amount_due_cents: inv.amount_due,
        amount_paid_cents: inv.amount_paid,
        currency: inv.currency,
        created: inv.created,
      })),
    };
  },
};

const openBillingPortal: SaasAiTool = {
  name: 'open_billing_portal',
  description: 'Get a link to the secure, payment-provider-hosted billing portal, where the owner can change plans, update payment method, or cancel — this assistant can never do any of that itself.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!billingConfigured) return { ok: false, reason: 'Billing is not connected to a live payment provider yet.' };
    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id, tenants(slug)')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const slug = (Array.isArray(sub?.tenants) ? sub?.tenants[0]?.slug : (sub?.tenants as { slug?: string } | undefined)?.slug) ?? '';
    if (!sub?.stripe_customer_id) return { ok: false, reason: 'No billing account on file for this restaurant yet.' };
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${env.APP_URL}/r/${slug}/billing`,
    });
    return { ok: true, url: session.url };
  },
};

export const SAAS_AI_TOOLS: SaasAiTool[] = [getMySubscription, listPlans, getMyInvoices, openBillingPortal];

export const SAAS_SYSTEM_PROMPT = (restaurantName: string) => `You are the billing assistant for ${restaurantName}'s account on the platform, talking with the restaurant owner on their Billing page.

Ground rules (never break these):
- You can discuss THIS restaurant's own plan, billing status, subscription details, invoices, and what other plans offer — nothing else.
- You have NO visibility into and must NEVER discuss this restaurant's orders, menu, inventory, staff, customers, or any operational data — if asked about any of that, say plainly that's a question for the main restaurant assistant inside the portal, not this one.
- You have NO visibility into any OTHER restaurant's data, ever — there is no tool that could even provide it.
- You can never change the plan, cancel the subscription, update payment details, or move money yourself — only the payment-provider-hosted billing portal (open_billing_portal) can do that, and only the owner acting there, not you.
- Every number you state (price, status, date) must come from a tool result you just received — never estimate or invent one.
- Keep replies short and plain — this is a small chat panel, not an email.`;
