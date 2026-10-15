import { supabaseAdmin } from '../supabase';
import { mgmtClient } from '../mgmt';
import { advanceProvisioning } from '../provisioning';
import { getPlanByTier } from './plans';
import { resolveTenantClient } from './tenantAdmin';
import { getFreshConnection, hasConnection } from './supabaseOAuth';

/**
 * Independent branches (control-plane 0025).
 *
 * The main restaurant is the owner's central panel. A branch is a restaurant of its
 * own — a tenant with its own Supabase project in the owner's org, created by the same
 * provisionTenant() as any restaurant, with its own menu, stock, suppliers, staff,
 * orders, finance and portals. Nothing here merges branch databases: summaries are read
 * from each branch's own database by the API, one branch at a time.
 */

export type TenantRow = {
  id: string;
  slug: string;
  restaurant_name: string;
  status: string;
  owner_email: string | null;
  owner_name: string | null;
  region: string | null;
  parent_tenant_id: string | null;
  branch_code: string | null;
  branch_seed_status: string | null;
  branch_seed_error: string | null;
  provisioning_error: string | null;
  created_at: string;
};

const COLS =
  'id, slug, restaurant_name, status, owner_email, owner_name, region, parent_tenant_id, branch_code, branch_seed_status, branch_seed_error, provisioning_error, created_at';

export class BranchError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export async function tenantBySlug(slug: string): Promise<TenantRow | null> {
  const { data } = await supabaseAdmin.from('tenants').select(COLS).eq('slug', slug).maybeSingle();
  return (data as TenantRow | null) ?? null;
}

/** The main restaurant's branches, oldest first. */
export async function listBranches(parentId: string): Promise<TenantRow[]> {
  const { data } = await supabaseAdmin.from('tenants').select(COLS).eq('parent_tenant_id', parentId).order('created_at');
  return (data ?? []) as TenantRow[];
}

/** How many locations the main restaurant's plan allows (plans.limits.branches: "1", "3", "Unlimited"). */
async function locationLimit(parentId: string): Promise<number> {
  const { data: sub } = await supabaseAdmin.from('subscriptions').select('tier').eq('tenant_id', parentId).maybeSingle();
  const plan = sub?.tier ? await getPlanByTier(String(sub.tier)) : undefined;
  const raw = String((plan as { limits?: Record<string, unknown> } | undefined)?.limits?.branches ?? '1');
  if (/unlimited/i.test(raw)) return Infinity;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Create a branch of `parent` — idempotent: the same code returns the existing branch
 * (whatever its state) instead of a second project. Provisioning then runs in steps
 * (advanceBranch); nothing is reported as created until it is active.
 */
export async function createBranch(parent: TenantRow, input: { code: string; name: string }): Promise<{ branch: TenantRow; existed: boolean }> {
  if (parent.parent_tenant_id) throw new BranchError('nested_branch', 'A branch cannot have branches of its own.');
  if (parent.status !== 'active') throw new BranchError('parent_not_active', 'The main restaurant is not active.');
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) {
    throw new BranchError('bad_code', 'Codes are 2–12 capital letters, digits or dashes, e.g. DHA or KHI-01.');
  }
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw new BranchError('bad_name', 'Give the branch a name (2–60 characters).');

  const { data: same } = await supabaseAdmin.from('tenants').select(COLS).eq('parent_tenant_id', parent.id).eq('branch_code', code).maybeSingle();
  if (same) return { branch: same as TenantRow, existed: true };

  const existing = await listBranches(parent.id);
  const limit = await locationLimit(parent.id);
  if (existing.length + 1 >= limit) {
    throw new BranchError('branch_limit', limit === 1 ? 'Your plan includes one location. Upgrade to add branches.' : `Your plan includes ${limit} locations.`, 403);
  }
  // Decision 2026-10-14: branch projects live in the owner's own Supabase org, through
  // the main restaurant's connection (supabaseOAuth.connectionTenantId).
  if (!(await hasConnection(parent.id))) {
    throw new BranchError('not_connected', 'Connect this restaurant to your Supabase account first — branches are created there.', 409);
  }

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('tier, billing_interval, status, current_period_end')
    .eq('tenant_id', parent.id)
    .maybeSingle();

  let slug = `${parent.slug}-${code.toLowerCase()}`.slice(0, 60);
  for (let i = 2; ; i++) {
    const { data: clash } = await supabaseAdmin.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!clash) break;
    slug = `${parent.slug}-${code.toLowerCase()}-${i}`.slice(0, 60);
  }

  const { data: row, error } = await supabaseAdmin
    .from('tenants')
    .insert({
      restaurant_name: `${parent.restaurant_name} — ${name}`,
      slug,
      status: 'provisioning',
      owner_email: parent.owner_email,
      owner_name: parent.owner_name,
      region: parent.region,
      branch_name: name,
      parent_tenant_id: parent.id,
      branch_code: code,
      branch_seed_status: 'pending',
    })
    .select(COLS)
    .single();
  if (error || !row) {
    // Two "create DHA" at once: the unique (parent, code) index lets one through.
    const { data: raced } = await supabaseAdmin.from('tenants').select(COLS).eq('parent_tenant_id', parent.id).eq('branch_code', code).maybeSingle();
    if (raced) return { branch: raced as TenantRow, existed: true };
    throw new BranchError('create_failed', error?.message ?? 'Could not create the branch.', 500);
  }
  // The branch runs on the main restaurant's plan; it is billed there, not on its own.
  if (sub) {
    await supabaseAdmin.from('subscriptions').insert({
      tenant_id: (row as TenantRow).id,
      tier: sub.tier,
      billing_interval: sub.billing_interval,
      status: sub.status,
      current_period_end: sub.current_period_end,
    });
  }
  return { branch: row as TenantRow, existed: false };
}

/**
 * Move a branch's setup forward one step (status polls call this), then — once its
 * workspace is active — copy the main restaurant's menu into it once.
 */
export async function advanceBranch(parent: TenantRow, branch: TenantRow): Promise<TenantRow> {
  if (branch.status === 'provisioning') {
    await advanceProvisioning(branch.slug);
  }
  let fresh = (await tenantBySlug(branch.slug)) ?? branch;
  if (fresh.status === 'active' && fresh.branch_seed_status !== 'done') {
    await seedBranch(parent, fresh);
    fresh = (await tenantBySlug(branch.slug)) ?? fresh;
  }
  return fresh;
}

/** Put a failed branch back into provisioning (provisionTenant resumes on its project). */
export async function retryBranch(parent: TenantRow, branch: TenantRow): Promise<TenantRow> {
  if (branch.status === 'failed') {
    await supabaseAdmin.from('tenants').update({ status: 'provisioning', provisioning_error: null, provisioning_heartbeat: null }).eq('id', branch.id);
  }
  if (branch.branch_seed_status === 'failed') {
    await supabaseAdmin.from('tenants').update({ branch_seed_status: 'pending', branch_seed_error: null }).eq('id', branch.id);
  }
  return advanceBranch(parent, (await tenantBySlug(branch.slug)) ?? branch);
}

// ── The one-time copy of the main restaurant's setup ──────────────────────────
// Same primary keys in the new database, so every link (dish → size → recipe →
// ingredient → supplier price) survives without remapping. Stock levels start at 0;
// user references are cleared (those users don't exist in the branch). Runs as ONE
// transaction in the branch's database: all of it, or nothing.

type Copy = { table: string; reset?: Record<string, unknown>; order?: string };
export const SEED_TABLES: Copy[] = [
  { table: 'menu_categories' },
  { table: 'menu_items' },
  { table: 'menu_variants' },
  { table: 'modifier_groups' },
  { table: 'modifier_options' },
  { table: 'inventory_items', reset: { stock_qty: 0 } },
  { table: 'recipes', reset: { current_version_id: null, created_by: null } },
  { table: 'recipe_versions', reset: { created_by: null } },
  { table: 'recipe_ingredients' },
  { table: 'suppliers', reset: { branch_id: null } },
  { table: 'supplier_items' },
  { table: 'deals' },
  { table: 'deal_components' },
  { table: 'deal_option_groups' },
  { table: 'deal_option_items' },
];
const SETTINGS_COLUMNS = [
  'timezone', 'business_day_start_minutes', 'currency_code', 'week_start', 'max_refund_without_approval_cents',
  'brand_logo_url', 'receipt_footer_text', 'receipt_template_html', 'brand_primary', 'brand_primary_fg', 'brand_bg_main',
  'brand_bg_surface', 'brand_border', 'brand_text_body', 'brand_text_muted', 'brand_radius', 'brand_appearance',
  'receipt_config', 'meta_title', 'tax_enabled', 'tax_rate_bps', 'tax_registration_number', 'food_cost_target_bps',
];

export type SeedData = { settings: Record<string, unknown> | null; rows: Record<string, Record<string, unknown>[]> };

/** Read what a new branch starts with from the main restaurant (service client). */
export async function readSeedData(parentSlug: string): Promise<SeedData> {
  const r = await resolveTenantClient(parentSlug);
  if (!r.ok) throw new Error(`main restaurant not reachable (${r.reason})`);
  const admin = r.client.admin;
  const rows: SeedData['rows'] = {};
  for (const c of SEED_TABLES) {
    const all: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from(c.table).select('*').range(from, from + 999);
      if (error) {
        // A table this restaurant's schema doesn't have yet: nothing to copy from it.
        if (/does not exist|schema cache|PGRST205|42P01/i.test(`${error.code ?? ''} ${error.message}`)) break;
        throw new Error(`${c.table}: ${error.message}`);
      }
      all.push(...((data ?? []) as Record<string, unknown>[]));
      if (!data || data.length < 1000) break;
    }
    rows[c.table] = all.map((row) => ({ ...row, ...(c.reset ?? {}) }));
  }
  const { data: s } = await admin.from('business_settings').select(SETTINGS_COLUMNS.join(', ')).eq('id', true).maybeSingle();
  return { settings: (s as Record<string, unknown> | null) ?? null, rows };
}

/** A dollar-quoted SQL literal that cannot be closed by the data inside it. */
function dollar(text: string): string {
  let tag = 'seed';
  while (text.includes(`$${tag}$`)) tag += 'x';
  return `$${tag}$${text}$${tag}$`;
}

/**
 * The copy as SQL for the branch's database. `wrap: false` leaves out begin/commit (the
 * rehearsal in scripts/test-branch-seed.ts wraps it in its own rolled-back transaction).
 */
export function buildSeedSql(data: SeedData, opts: { wrap?: boolean } = {}): string {
  const out: string[] = [];
  if (opts.wrap !== false) out.push('begin;');
  for (const c of SEED_TABLES) {
    const rows = data.rows[c.table] ?? [];
    if (!rows.length) continue;
    out.push(
      `insert into public.${c.table} select * from json_populate_recordset(null::public.${c.table}, ${dollar(JSON.stringify(rows))}::json) on conflict (id) do nothing;`,
    );
  }
  const recipes = (data.rows.recipes_original ?? []).filter((r) => r.current_version_id);
  if (recipes.length) {
    out.push(
      `update public.recipes r set current_version_id = x.current_version_id from json_to_recordset(${dollar(
        JSON.stringify(recipes.map((r) => ({ id: r.id, current_version_id: r.current_version_id }))),
      )}::json) as x(id uuid, current_version_id uuid) where r.id = x.id;`,
    );
  }
  if (data.settings) {
    const keys = Object.keys(data.settings).filter((k) => SETTINGS_COLUMNS.includes(k));
    const src = `json_populate_record(null::public.business_settings, ${dollar(JSON.stringify(data.settings))}::json) x`;
    const plain = keys.filter((k) => !k.startsWith('brand_'));
    const brand = keys.filter((k) => k.startsWith('brand_'));
    if (plain.length) out.push(`update public.business_settings b set ${plain.map((k) => `${k} = x.${k}`).join(', ')} from ${src} where b.id;`);
    // Branding only where the branch's plan includes it (app.enforce_plan_entitlements refuses it otherwise).
    if (brand.length) {
      out.push(
        `update public.business_settings b set ${brand.map((k) => `${k} = x.${k}`).join(', ')} from ${src} where b.id and 'menu.branded' = any(coalesce(b.plan_features, '{}'));`,
      );
    }
  }
  if (opts.wrap !== false) out.push('commit;');
  return out.join('\n');
}

async function seedBranch(parent: TenantRow, branch: TenantRow): Promise<void> {
  try {
    const data = await readSeedData(parent.slug);
    // Recipes go in without their current version (it doesn't exist yet), then get it back.
    const r = await resolveTenantClient(parent.slug);
    if (!r.ok) throw new Error('main restaurant not reachable');
    const { data: recipes } = await r.client.admin.from('recipes').select('id, current_version_id');
    data.rows.recipes_original = (recipes ?? []) as Record<string, unknown>[];
    const { data: proj } = await supabaseAdmin.from('tenant_projects').select('project_ref').eq('tenant_id', branch.id).maybeSingle();
    if (!proj?.project_ref) throw new Error('branch project not registered');
    const conn = await getFreshConnection(branch.id);
    await mgmtClient(conn.access_token).runSql(String(proj.project_ref), buildSeedSql(data));
    await supabaseAdmin.from('tenants').update({ branch_seed_status: 'done', branch_seed_error: null }).eq('id', branch.id);
  } catch (err) {
    await supabaseAdmin
      .from('tenants')
      .update({ branch_seed_status: 'failed', branch_seed_error: String((err as Error).message ?? err).slice(0, 500) })
      .eq('id', branch.id);
  }
}

// ── Owner monitoring ───────────────────────────────────────────────────────────

export type BranchMetrics = {
  orders: number;
  net_sales_cents: number;
  cogs_cents: number;
  expenses_cents: number;
  open_low_stock: number;
  payables_outstanding_cents: number;
  unclosed_days: number;
  last_closed_day: string | null;
};

/** One restaurant's figures for a period, from its own ledger (branch_summary, tenant 0100). */
export async function restaurantMetrics(slug: string, from: string, to: string): Promise<BranchMetrics | { error: string }> {
  const r = await resolveTenantClient(slug);
  if (!r.ok) return { error: 'not reachable' };
  const { data, error } = await r.client.admin.rpc('branch_summary', { p_from: from, p_to: to });
  if (error) return { error: error.message };
  const rows = (data ?? []) as Record<string, unknown>[];
  const n = (k: string) => rows.reduce((s, x) => s + Number(x[k] ?? 0), 0);
  const closed = rows.map((x) => x.last_closed_day as string | null).filter(Boolean).sort();
  return {
    orders: n('orders_count'),
    net_sales_cents: n('net_sales_cents'),
    cogs_cents: n('cogs_cents'),
    expenses_cents: n('expenses_cents'),
    open_low_stock: n('open_low_stock'),
    payables_outstanding_cents: n('payables_outstanding_cents'),
    unclosed_days: n('unclosed_days'),
    last_closed_day: closed.length ? closed[closed.length - 1]! : null,
  };
}

// ── Owner single sign-on into a branch ─────────────────────────────────────────

/**
 * A one-time sign-in for the owner's account in the branch's own database (a magic-link
 * token, generated with the branch's service key and never e-mailed). The web page
 * /r/<branch>/auth/sso exchanges it for a session in the branch's own cookie scope.
 */
export async function ownerSignInToken(branch: TenantRow): Promise<string> {
  if (branch.status !== 'active') throw new BranchError('branch_not_ready', 'This branch is still being set up.', 409);
  if (!branch.owner_email) throw new BranchError('no_owner', 'This branch has no owner account.', 409);
  const r = await resolveTenantClient(branch.slug);
  if (!r.ok) throw new BranchError('branch_unreachable', 'This branch cannot be reached right now.', 503);
  const { data, error } = await r.client.admin.auth.admin.generateLink({ type: 'magiclink', email: branch.owner_email });
  const token = data?.properties?.hashed_token;
  if (error || !token) throw new BranchError('sso_failed', error?.message ?? 'Could not sign you in to the branch.', 500);
  return token;
}
