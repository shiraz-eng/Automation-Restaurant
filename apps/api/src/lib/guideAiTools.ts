import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import { getActivePlans } from './plans';
import { supabaseAdmin } from '../supabase';
import { stripe, billingConfigured } from '../stripe';
import { hasFeature, ENTITLED_STATUSES } from '@automation-restaurant/shared';
import type { FeatureKey, SubscriptionStatus } from '@automation-restaurant/shared';

/**
 * tools/system-prompt for the Automation Restaurant AI Guide.
 *
 * This assistant is a PRODUCT GUIDE / CUSTOMER SUCCESS AI — completely separate from:
 *   - routes/ai.ts         (restaurant operations AI — menu/orders/inventory)
 *   - routes/saasAi.ts     (billing AI — plan/invoice questions)
 *   - routes/customerAi.ts (public customer ordering AI)
 *
 * Security model:
 *   PUBLIC tools:   run with no auth context; only touch public API data (plans, FAQ).
 *   AUTH tools:     run with `admin` (control-plane service client) and a `tenantId`
 *                   resolved server-side from the caller's verified session BEFORE any
 *                   tool runs.  They are NEVER handed tenant project credentials;
 *                   they CANNOT reach orders/menu/inventory/staff/cross-tenant data.
 *
 * The model is instructed to refuse secrets, refuse cross-tenant requests, and
 * explain things in plain language. Implementation-level enforcement (separate from
 * the prompt) lives in the route handler (guideAi.ts).
 */

// ─── Tool type (mirrors saasAiTools.ts shape) ─────────────────────────────────

export type GuideAiTool = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** `admin` is the control-plane service client; `tenantId` is empty string for public tools. */
  run: (
    admin: SupabaseClient,
    tenantId: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

// ─── Public tools (no auth context required) ──────────────────────────────────

const getPlansAndPricing: GuideAiTool = {
  name: 'get_plans_and_pricing',
  description:
    'Returns all available Automation Restaurant plans — names, pricing (monthly + annual), feature highlights, and limits. Use this to answer pricing questions, plan comparison questions, or to explain what is included in each tier.',
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
        currency: p.currency,
        highlights: p.highlights,
        limits: p.limits,
        features: p.features,
      })),
    };
  },
};

const getFeatureDescriptions: GuideAiTool = {
  name: 'get_feature_descriptions',
  description:
    'Returns plain-English descriptions of all platform features and what they do for a restaurant. Use when the user asks about a specific capability, what a plan includes, or why a feature matters.',
  input_schema: { type: 'object', properties: {} },
  run: async () => ({
    features: {
      'pos.multi_terminal': {
        name: 'Multi-terminal POS',
        what: 'Run the Point of Sale on multiple devices simultaneously.',
        why: 'Larger restaurants with multiple cashier stations need each to operate independently.',
        gain: 'No bottleneck at a single checkout point during peak hours.',
      },
      'kds.realtime': {
        name: 'Realtime Kitchen Display',
        what: 'Kitchen Display System shows orders updating in real time without page refresh.',
        why: 'Kitchen staff see new orders and status changes the instant they happen.',
        gain: 'Faster ticket response time; no missed orders from stale displays.',
      },
      'kds.station_routing': {
        name: 'KDS Station Routing',
        what: 'Route different order types or menu categories to specific kitchen stations.',
        why: 'A grill station should only see grill items; a dessert station should only see desserts.',
        gain: 'Reduces noise and errors in a multi-station kitchen.',
      },
      'inventory.recipe_deduction': {
        name: 'Recipe-based Inventory Deduction',
        what: 'When a menu item is sold, its ingredients are automatically deducted from stock.',
        why: 'Manual stock counting is slow and error-prone.',
        gain: 'Always know real stock levels; low-stock alerts trigger automatically.',
      },
      'inventory.predictive_ai': {
        name: 'Predictive Inventory AI',
        what: 'AI analyses sales patterns and suggests reorder quantities.',
        why: 'Prevents both over-ordering (waste) and under-ordering (stockouts).',
        gain: 'Better cash flow and fewer 86\'d menu items.',
      },
      'menu.branded': {
        name: 'Branded Menu & Ordering',
        what: 'Customer-facing ordering pages show your restaurant\'s logo, colors, and brand.',
        why: 'The default (unbranded) ordering page is functional but generic.',
        gain: 'Customer experience matches your restaurant\'s identity.',
      },
      'menu.white_label': {
        name: 'White-label Menus',
        what: 'Remove all Automation Restaurant branding from customer-facing pages.',
        why: 'Enterprise customers or franchises want a fully owned experience.',
        gain: 'Complete brand ownership with no third-party attribution.',
      },
      'sync.offline_6h': {
        name: '6-hour Offline Sync',
        what: 'Portals continue working for up to 6 hours without an internet connection.',
        why: 'Restaurants in areas with unreliable connectivity cannot afford downtime.',
        gain: 'Orders keep flowing even during an outage; data syncs when reconnected.',
      },
      'sync.mesh': {
        name: 'Mesh Sync',
        what: 'Devices sync with each other peer-to-peer in addition to the server.',
        why: 'Even faster sync and offline resilience in large or multi-device setups.',
        gain: 'Near-instant sync across all devices, maximum resilience.',
      },
      'branches.multi': {
        name: 'Multi-location / Branches',
        what: 'Manage multiple restaurant locations under one account.',
        why: 'Chains and groups need central visibility across branches.',
        gain: 'One dashboard, one billing relationship, per-branch reporting.',
      },
    },
  }),
};

const getFaqContent: GuideAiTool = {
  name: 'get_faq_content',
  description:
    'Returns the published FAQ items from the CMS, grouped by category. Use when the user asks a question that is likely covered by product documentation or frequently-asked questions.',
  input_schema: { type: 'object', properties: {} },
  run: async () => {
    const { data } = await supabaseAdmin
      .from('faq_items')
      .select('category, question, answer')
      .eq('is_published', true)
      .order('sort_order');
    return { faq: data ?? [] };
  },
};

// ─── Authenticated tools (require tenantId resolved from verified session) ────

const getMyAccount: GuideAiTool = {
  name: 'get_my_account',
  description:
    'Returns this restaurant\'s account state: restaurant name, plan tier, subscription status (active/trialing/past_due/canceled), trial end date, provisioning status, and enabled features. Only the calling user\'s own restaurant is ever returned.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!tenantId) return { error: 'not_authenticated' };
    const { data: t } = await admin
      .from('tenants')
      .select('restaurant_name, slug, status, project_url')
      .eq('id', tenantId)
      .maybeSingle();
    if (!t) return { found: false };

    const { data: sub } = await admin
      .from('subscriptions')
      .select('tier, billing_interval, status, trial_end, current_period_end')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const plans = await getActivePlans();
    const plan = sub ? plans.find((p) => p.tier === sub.tier) : undefined;

    const entitled = sub ? ENTITLED_STATUSES.includes(sub.status as typeof ENTITLED_STATUSES[number]) : false;

    return {
      found: true,
      restaurant_name: t.restaurant_name,
      slug: t.slug,
      provisioning_status: t.status,
      project_url: t.project_url ?? null,
      plan_name: plan?.name ?? sub?.tier ?? 'Unknown',
      plan_tier: sub?.tier ?? null,
      subscription_status: sub?.status ?? null,
      billing_interval: sub?.billing_interval ?? null,
      trial_end: sub?.trial_end ?? null,
      current_period_end: sub?.current_period_end ?? null,
      is_entitled: entitled,
    };
  },
};

const checkOnboardingProgress: GuideAiTool = {
  name: 'check_onboarding_progress',
  description:
    'Checks how far along this restaurant\'s setup is — counts menu items, staff, portals, and key settings. Returns a checklist of what is complete and what still needs to be done. Use proactively after get_my_account when the account is active.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!tenantId) return { error: 'not_authenticated' };

    // Resolve the tenant's project URL and anon key to query its own DB.
    const { data: t } = await admin
      .from('tenants')
      .select('project_url, anon_key, slug')
      .eq('id', tenantId)
      .maybeSingle();

    if (!t?.project_url || !t?.anon_key) {
      return { error: 'project_not_provisioned', message: 'The restaurant project is not yet provisioned or connected.' };
    }

    const projectUrl = t.project_url;
    const anonKey = t.anon_key;

    // Query the tenant's own Supabase project via its REST API (anon key — only
    // reads counts from tables that have RLS policies allowing service access; we
    // use the service-client workaround via supabase-js with the anon key since
    // we do NOT hold the tenant's service_role key server-side after provisioning).
    async function countRows(table: string): Promise<number> {
      try {
        const res = await fetch(
          `${projectUrl}/rest/v1/${table}?select=id&limit=1`,
          { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } },
        );
        if (!res.ok) return -1;
        const countHeader = res.headers.get('content-range');
        // content-range: 0-0/42 → total is 42
        const total = countHeader ? parseInt(countHeader.split('/')[1] ?? '-1', 10) : -1;
        return total;
      } catch {
        return -1;
      }
    }

    const [menuCount, staffCount] = await Promise.all([
      countRows('menu_items'),
      countRows('staff'),
    ]);

    const checklist = [
      {
        key: 'restaurant_provisioned',
        label: 'Restaurant project created',
        done: true,
        link: null,
      },
      {
        key: 'menu_items',
        label: 'Menu items added',
        done: menuCount > 0,
        count: menuCount >= 0 ? menuCount : undefined,
        link: `/r/${t.slug}/menu`,
      },
      {
        key: 'staff',
        label: 'Staff invited',
        done: staffCount > 0,
        count: staffCount >= 0 ? staffCount : undefined,
        link: `/r/${t.slug}/staff`,
      },
    ];

    const incomplete = checklist.filter((c) => !c.done);
    return {
      checklist,
      complete_count: checklist.filter((c) => c.done).length,
      total_count: checklist.length,
      all_done: incomplete.length === 0,
      incomplete_summary: incomplete.map((c) => c.label),
    };
  },
};

const getFeatureEntitlement: GuideAiTool = {
  name: 'get_feature_entitlement',
  description:
    'Checks whether this restaurant\'s current plan includes a specific feature. Use when the user asks why something is locked, or which plan they need for a feature. feature_key must be one of the known FeatureKey values.',
  input_schema: {
    type: 'object',
    properties: {
      feature_key: {
        type: 'string',
        description:
          'The feature to check, e.g. "kds.realtime", "inventory.recipe_deduction", "menu.branded", "branches.multi".',
      },
    },
    required: ['feature_key'],
  },
  run: async (admin, tenantId, { feature_key }) => {
    if (!tenantId) return { error: 'not_authenticated' };
    const key = String(feature_key) as FeatureKey;

    const { data: sub } = await admin
      .from('subscriptions')
      .select('tier, status')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!sub) return { error: 'no_subscription' };

    const plans = await getActivePlans();
    const currentPlan = plans.find((p) => p.tier === sub.tier);

    const entitled = hasFeature(currentPlan, sub.status as SubscriptionStatus, key);

    // Find which plan(s) include this feature.
    const requiredPlans = plans
      .filter((p) => (p.features as FeatureKey[]).includes(key))
      .map((p) => ({ tier: p.tier, name: p.name, price_monthly_cents: p.priceMonthlyCents }));

    return {
      feature_key: key,
      entitled,
      current_plan: currentPlan?.name ?? sub.tier,
      current_status: sub.status,
      plans_with_feature: requiredPlans,
      upgrade_needed: !entitled && requiredPlans.length > 0,
    };
  },
};

const getBillingInfo: GuideAiTool = {
  name: 'get_billing_info',
  description:
    'Returns this restaurant\'s subscription status, recent invoices, and payment history. Use when the user asks about their bill, a failed payment, what they owe, or their renewal date.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!tenantId) return { error: 'not_authenticated' };
    const { data: sub } = await admin
      .from('subscriptions')
      .select('tier, billing_interval, status, current_period_end, stripe_customer_id')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (!sub) return { found: false };

    let invoices: unknown[] = [];
    if (billingConfigured && sub.stripe_customer_id) {
      try {
        const list = await stripe.invoices.list({ customer: sub.stripe_customer_id, limit: 5 });
        invoices = list.data.map((inv) => ({
          status: inv.status,
          amount_due_cents: inv.amount_due,
          amount_paid_cents: inv.amount_paid,
          currency: inv.currency,
          created: inv.created,
          due_date: inv.due_date,
          invoice_pdf: inv.invoice_pdf,
        }));
      } catch {
        invoices = [];
      }
    }

    return {
      found: true,
      status: sub.status,
      tier: sub.tier,
      billing_interval: sub.billing_interval,
      current_period_end: sub.current_period_end,
      payment_provider_connected: billingConfigured && !!sub.stripe_customer_id,
      invoices,
    };
  },
};

const openBillingPortal: GuideAiTool = {
  name: 'open_billing_portal',
  description:
    'Returns a secure, time-limited link to the payment provider\'s billing portal where the owner can update their payment method, change plan, or cancel. IMPORTANT: Never ask for card details in chat — always use this link instead.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!tenantId) return { error: 'not_authenticated' };
    if (!billingConfigured) {
      return { ok: false, reason: 'Billing is not connected to a live payment provider yet.' };
    }
    const { data: sub } = await admin
      .from('subscriptions')
      .select('stripe_customer_id, tenants(slug)')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const slug =
      (Array.isArray(sub?.tenants) ? sub?.tenants[0]?.slug : (sub?.tenants as { slug?: string } | undefined)?.slug) ?? '';
    if (!sub?.stripe_customer_id) {
      return { ok: false, reason: 'No billing account on file yet. Complete sign-up to activate billing.' };
    }
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id,
        return_url: `${env.APP_URL}/r/${slug}/billing`,
      });
      return { ok: true, url: session.url };
    } catch (err) {
      return { ok: false, reason: String((err as Error).message ?? 'Failed to create billing portal session.') };
    }
  },
};

const diagnoseProject: GuideAiTool = {
  name: 'diagnose_project',
  description:
    'Checks the health of this restaurant\'s Supabase project: whether it is active, paused, or has a billing restriction. Use when the user reports that their dashboard is blank, data is not loading, or the restaurant is not accessible.',
  input_schema: { type: 'object', properties: {} },
  run: async (admin, tenantId) => {
    if (!tenantId) return { error: 'not_authenticated' };
    const { data: t } = await admin
      .from('tenants')
      .select('status, project_url, anon_key')
      .eq('id', tenantId)
      .maybeSingle();

    if (!t) return { error: 'tenant_not_found' };
    if (!t.project_url) {
      return {
        provisioning_status: t.status,
        project_reachable: false,
        classification: 'not_provisioned',
        plain_english: 'The restaurant project has not been provisioned yet, or provisioning is still in progress.',
      };
    }

    // Probe the project health endpoint.
    let httpStatus = 0;
    let responseBody = '';
    try {
      const res = await fetch(`${t.project_url}/health`, {
        headers: { apikey: t.anon_key ?? '', Authorization: `Bearer ${t.anon_key ?? ''}` },
        signal: AbortSignal.timeout(8000),
      });
      httpStatus = res.status;
      responseBody = await res.text().catch(() => '');
    } catch (err) {
      return {
        provisioning_status: t.status,
        project_reachable: false,
        classification: 'unreachable',
        plain_english:
          'The project could not be reached at all — this usually means a network issue or the project URL is incorrect. It does not necessarily mean the project is permanently down.',
        error: String((err as Error).message ?? err).slice(0, 200),
      };
    }

    let classification: string;
    let plain_english: string;

    if (httpStatus === 200) {
      classification = 'active';
      plain_english = 'The project is active and responding normally.';
    } else if (httpStatus === 503 || httpStatus === 0) {
      classification = 'paused_or_starting';
      plain_english =
        'The project returned a 503 / Service Unavailable response. This typically means the Supabase project is paused. Free-plan projects are automatically paused after a period of inactivity. You can resume it from your Supabase dashboard (supabase.com) — go to the project settings and click Resume.';
    } else if (httpStatus === 402) {
      classification = 'billing_restricted';
      plain_english =
        'The project has a billing or quota restriction on the Supabase side (402 Payment Required). This is separate from your Automation Restaurant subscription — it means the Supabase project itself has an overdue payment or has exceeded its free-tier quota. Log in to supabase.com to resolve it.';
    } else if (httpStatus === 401 || httpStatus === 403) {
      classification = 'auth_error';
      plain_english =
        `The project is reachable but the request was not authorized (HTTP ${httpStatus}). This may indicate the stored API key is incorrect or has been rotated.`;
    } else {
      classification = 'unexpected_error';
      plain_english = `The project returned an unexpected HTTP ${httpStatus} response.`;
    }

    return {
      provisioning_status: t.status,
      project_reachable: httpStatus > 0,
      http_status: httpStatus,
      classification,
      plain_english,
      response_preview: responseBody.slice(0, 300),
    };
  },
};

const getSupportSummary: GuideAiTool = {
  name: 'get_support_summary',
  description:
    'Composes a structured human-support escalation summary for this restaurant — tenant details, current plan, subscription status, and any diagnostic information already gathered. Use this when the AI cannot resolve an issue and the user needs to contact support.',
  input_schema: {
    type: 'object',
    properties: {
      issue_description: {
        type: 'string',
        description: 'Plain description of the problem as understood so far.',
      },
      steps_tried: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of steps the AI already attempted or suggested.',
      },
    },
    required: ['issue_description'],
  },
  run: async (admin, tenantId, { issue_description, steps_tried }) => {
    if (!tenantId) {
      return {
        summary: `Issue: ${issue_description}\nSteps tried: ${(steps_tried as string[] | undefined)?.join(', ') ?? 'none'}\nNote: User was not authenticated — no account context available.`,
        support_email: env.SUPPORT_EMAIL,
      };
    }

    const { data: t } = await admin
      .from('tenants')
      .select('restaurant_name, slug, status')
      .eq('id', tenantId)
      .maybeSingle();

    const { data: sub } = await admin
      .from('subscriptions')
      .select('tier, status, billing_interval')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const lines = [
      `**Restaurant:** ${t?.restaurant_name ?? 'Unknown'} (/${t?.slug ?? '?'})`,
      `**Provisioning status:** ${t?.status ?? 'Unknown'}`,
      `**Plan:** ${sub?.tier ?? 'None'} (${sub?.billing_interval ?? '?'})`,
      `**Subscription status:** ${sub?.status ?? 'None'}`,
      `**Issue:** ${issue_description}`,
      `**Steps already tried:** ${(steps_tried as string[] | undefined)?.join('; ') ?? 'None'}`,
    ];

    return {
      summary: lines.join('\n'),
      support_email: env.SUPPORT_EMAIL,
      instructions: `Please email ${env.SUPPORT_EMAIL} with the summary above. Our team will have full context without you needing to repeat everything.`,
    };
  },
};

// ─── Tool sets ────────────────────────────────────────────────────────────────

/** Available to everyone including unauthenticated public visitors. */
export const GUIDE_PUBLIC_TOOLS: GuideAiTool[] = [
  getPlansAndPricing,
  getFeatureDescriptions,
  getFaqContent,
];

/** Added on top of public tools when a verified portal session is present. */
export const GUIDE_AUTH_TOOLS: GuideAiTool[] = [
  getMyAccount,
  checkOnboardingProgress,
  getFeatureEntitlement,
  getBillingInfo,
  openBillingPortal,
  diagnoseProject,
  getSupportSummary,
];

export const ALL_GUIDE_TOOLS = [...GUIDE_PUBLIC_TOOLS, ...GUIDE_AUTH_TOOLS];

// ─── System prompt ────────────────────────────────────────────────────────────

export const GUIDE_SYSTEM_PROMPT = (mode: 'public' | 'authenticated', restaurantName?: string) => `\
You are the **Automation Restaurant AI Guide** — a knowledgeable, patient product specialist \
and customer-success assistant for the Automation Restaurant platform.

Your role is: GUIDE → EXPLAIN → DIAGNOSE → RESOLVE → ONBOARD → CONVERT

${mode === 'authenticated'
  ? `You are currently speaking with an authenticated user${restaurantName ? ` from **${restaurantName}**` : ''}. \
You have access to their account, subscription, and restaurant data through the tools provided. \
Always start by using get_my_account to understand their current situation before giving advice.`
  : `You are speaking with a visitor on the Automation Restaurant public website — they are NOT logged in. \
Focus on explaining the platform, its value, pricing, and how to get started. \
Do not attempt to access account-specific data.`
}

## Platform Knowledge
Automation Restaurant is a multi-tenant SaaS restaurant operating system. It provides:
- A **control plane** (the SaaS layer): handles subscriptions, provisioning, plans, billing.
- **Per-restaurant Supabase projects** (the tenant layer): each restaurant gets its own isolated database.
- **Role-specific portals**: Owner, Manager, Kitchen, Cashier, Waiter, Floor, Finance — each role sees only what they need.
- **AI assistance** built into operations: Smart Import, inventory prediction, scheduling, AI chat for the operations team.
- **Customer ordering**: guest-facing order/track pages, QR table ordering.

## Tone & Style
- Clear, practical, patient, concise.
- Non-technical by default. Only go technical if the user explicitly asks.
- Never condescending. Never overwhelming.
- Short paragraphs. Use bullet lists only when listing steps or options.
- Use plain language to explain technical errors (RLS = "database permission", 503 = "server was unavailable", etc.).

## Hard Rules (never break these)
1. **Never ask for secrets.** Never request a service_role key, database password, Stripe secret key, \
   Supabase access token, SMTP password, or OAuth client secret. If the user pastes one, immediately \
   warn them to rotate it and do not echo it back.
2. **Never reveal other restaurants' data.** Your tools are scoped to a single tenantId resolved \
   server-side — it is architecturally impossible for you to reach another restaurant's data.
3. **Never execute SQL from the user.** Do not run, suggest running, or help craft arbitrary queries \
   against the production database.
4. **Never invent data.** Every number, price, status, and date you state must come from a tool result \
   you just received. Do not estimate or fabricate.
5. **Never claim a payment succeeded** unless the billing tool confirms it.
6. **Distinguish the two billing relationships**: \
   Automation Restaurant subscription (plans, SaaS access) ≠ Supabase billing (the underlying project infrastructure). \
   Users often confuse these — always clarify when relevant.
7. **Escalate when you cannot safely resolve something**: billing disputes, data loss, security incidents, \
   provider outages, repeated failures. Use get_support_summary to compose a useful escalation package.

## Error Code Guide (for translating technical errors to plain English)
- **42501**: The database denied the request due to a permission rule (Row Level Security policy). \
  The data is there but the current user is not permitted to see or modify it.
- **401**: The request was not authenticated — the session may have expired or the key is wrong.
- **403**: Authenticated but not authorized — the role/permission does not allow this action.
- **402**: The provider has applied a billing or quota restriction. Check the provider dashboard.
- **503**: The server or project was unavailable — could be paused (Supabase Free Plan auto-pauses \
  inactive projects) or temporarily down.
- **5XX**: Server-side failure — different from a bad request; retry after a short wait.

## Onboarding Checklist (use check_onboarding_progress proactively)
If the user's restaurant exists but setup is incomplete, proactively show what's left:
- No menu items → "You've created your restaurant but haven't added menu items yet."
- No staff → "Your menu is ready but no kitchen or cashier staff have been invited."
- Subscription past_due → "There's a payment issue with your subscription. Let me check the details."

## Feature / Plan Guidance
When a user asks why something is locked or unavailable:
1. Call get_feature_entitlement with the relevant feature_key.
2. Report: current plan, whether the feature is included, and which plan(s) include it.
3. Offer to show the billing portal if an upgrade is appropriate.

## What You Are NOT
- NOT the restaurant operations AI (which handles orders/menu/inventory for the restaurant team).
- NOT the customer food-ordering AI (which handles ordering for restaurant guests).
- NOT a billing portal (you can get a link to it, but you cannot change plans or process payments).
- NOT a database query tool (you cannot run SQL).
`;
