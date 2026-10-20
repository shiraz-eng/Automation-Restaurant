import { randomBytes } from 'node:crypto';
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

/**
 * How many branches the main restaurant's plan allows (plans.limits.branches: "1", "3",
 * "Unlimited") — 0 on a plan without multi-branch. The main restaurant is the owner's panel
 * (decision 2026-10-18), so every location is a branch and the panel itself doesn't count.
 */
async function branchLimit(parentId: string): Promise<number> {
  const { data: sub } = await supabaseAdmin.from('subscriptions').select('tier').eq('tenant_id', parentId).maybeSingle();
  const plan = sub?.tier ? await getPlanByTier(String(sub.tier)) : undefined;
  const p = plan as { limits?: Record<string, unknown>; features?: string[] } | undefined;
  if (!p?.features?.includes('branches.multi')) return 0;
  const raw = String(p.limits?.branches ?? '1');
  if (/unlimited/i.test(raw)) return Infinity;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Create a branch of `parent` — idempotent: the same code returns the existing branch
 * (whatever its state) instead of a second project. Provisioning then runs in steps
 * (advanceBranch); nothing is reported as created until it is active.
 */
export async function createBranch(
  parent: TenantRow,
  input: { code: string; name: string; receipt?: Partial<ReceiptDetails> },
): Promise<{ branch: TenantRow; existed: boolean; receiptPending?: boolean }> {
  if (parent.parent_tenant_id) throw new BranchError('nested_branch', 'A branch cannot have branches of its own.');
  if (parent.status !== 'active') throw new BranchError('parent_not_active', 'The main restaurant is not active.');
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) {
    throw new BranchError('bad_code', 'Codes are 2–12 capital letters, digits or dashes, e.g. DHA or KHI-01.');
  }
  const name = input.name.trim();
  if (name.length < 2 || name.length > 60) throw new BranchError('bad_name', 'Give the branch a name (2–60 characters).');
  // Checked before anything is written, so a bad detail never leaves a half-made branch.
  const receipt = cleanReceipt(input.receipt);

  const { data: same } = await supabaseAdmin.from('tenants').select(COLS).eq('parent_tenant_id', parent.id).eq('branch_code', code).maybeSingle();
  if (same) return { branch: same as TenantRow, existed: true };

  const existing = await listBranches(parent.id);
  const limit = await branchLimit(parent.id);
  if (limit === 0) throw new BranchError('branch_limit', 'Branches are part of the Enterprise plan. Upgrade to add branches.', 403);
  // An archived branch still has its project, so it still counts.
  if (existing.length >= limit) throw new BranchError('branch_limit', `Your plan includes ${limit} branch${limit === 1 ? '' : 'es'}.`, 403);
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
  // Receipt details given now wait until the branch's database exists (control-plane 0026).
  let receiptPending: boolean | undefined;
  if (receipt) {
    const { error: setupErr } = await supabaseAdmin.from('tenants').update({ branch_setup: { receipt } }).eq('id', (row as TenantRow).id);
    receiptPending = !setupErr;
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
  return { branch: row as TenantRow, existed: false, receiptPending };
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
  // After the copy (which brings the main restaurant's receipt footer), the details the
  // owner gave for THIS branch go in.
  if (fresh.status === 'active' && fresh.branch_seed_status === 'done') await applyPendingSetup(fresh);
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
  // Which recipe each dish uses. Without it a branch's dishes sell without deducting any
  // stock until each recipe is re-saved there (found 2026-10-20 in DHA). What one portion
  // deducts (recipe_components) is rebuilt from these links in buildSeedSql, never copied:
  // a copy beside rows the branch already has would deduct twice.
  { table: 'recipe_links' },
  { table: 'modifier_recipe_components' },
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
      `insert into public.${c.table} select * from json_populate_recordset(null::public.${c.table}, ${dollar(JSON.stringify(rows))}::json) on conflict do nothing;`,
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
  // Each linked dish's stock rows, from its recipe's active version — the same function the
  // Recipes page uses, which replaces a dish's rows instead of adding beside them.
  if ((data.rows.recipe_links ?? []).length) {
    out.push('select app.sync_recipe_components(r.id) from public.recipes r where exists (select 1 from public.recipe_links l where l.recipe_id = r.id);');
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

/** Does this restaurant have a menu to copy? */
async function hasMenu(slug: string): Promise<boolean> {
  const r = await resolveTenantClient(slug);
  if (!r.ok) return false;
  const { count } = await r.client.admin.from('menu_items').select('id', { count: 'exact', head: true });
  return (count ?? 0) > 0;
}

/**
 * Where a new branch's menu comes from: the main restaurant's, if it has one (a restaurant
 * that ran before it became an owner panel); otherwise the oldest active branch that has a
 * menu — so a new owner sets the menu up once, in the first branch, and every later branch
 * starts from it. With neither, the branch starts empty. Settings come from the same restaurant.
 */
async function seedSource(parent: TenantRow, branch: TenantRow): Promise<string> {
  if (await hasMenu(parent.slug)) return parent.slug;
  for (const b of await listBranches(parent.id)) {
    if (b.id !== branch.id && b.status === 'active' && (await hasMenu(b.slug))) return b.slug;
  }
  return parent.slug;
}

async function seedBranch(parent: TenantRow, branch: TenantRow): Promise<void> {
  try {
    const source = await seedSource(parent, branch);
    const data = await readSeedData(source);
    // Recipes go in without their current version (it doesn't exist yet), then get it back.
    const r = await resolveTenantClient(source);
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

// ── The branch's own login ─────────────────────────────────────────────────────
// Each branch has one Branch manager login in the branch's OWN database, set by the
// owner. It works the whole branch — orders, kitchen, menu, stock, suppliers, finance,
// staff and portals — but never billing, restaurant settings (currency, tax, branding,
// refund rules) or branches: those stay with the owner. It can never reach another
// branch, which is a different database.

const BRANCH_MANAGER = 'branch_manager';
const HIDDEN_FROM_BRANCH = (key: string) => key.startsWith('settings.') || key.startsWith('branches.');

export type BranchLogin = { email: string; name: string | null; created_at: string | null };

async function branchAdmin(branch: TenantRow) {
  if (branch.status !== 'active') throw new BranchError('branch_not_ready', 'This branch is not active.', 409);
  const r = await resolveTenantClient(branch.slug);
  if (!r.ok) throw new BranchError('branch_unreachable', 'This branch cannot be reached right now.', 503);
  return r.client.admin;
}

/** The branch's login (email and name), or null when none is set yet. Never a password. */
export async function branchLogin(branch: TenantRow): Promise<BranchLogin | null> {
  const admin = await branchAdmin(branch);
  const { data } = await admin
    .from('memberships')
    .select('email, full_name, created_at')
    .eq('role', BRANCH_MANAGER)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  const m = data as { email: string; full_name: string | null; created_at: string | null } | null;
  return m ? { email: m.email, name: m.full_name, created_at: m.created_at } : null;
}

/** A password that is easy to read out and type: 3 groups of 4 (no 0/O, 1/l/I). */
function generatePassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const s = Array.from(randomBytes(12), (b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/**
 * Create the branch's login, or change its email / name / password. The password is
 * returned ONCE (generated when not given) and is never stored readable anywhere.
 */
export async function setBranchLogin(
  branch: TenantRow,
  input: { email?: string; name?: string | null; password?: string; newPassword?: boolean },
): Promise<{ email: string; password: string | null }> {
  const admin = await branchAdmin(branch);
  const { data: current } = await admin
    .from('memberships')
    .select('id, user_id, email')
    .eq('role', BRANCH_MANAGER)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  const cur = current as { id: string; user_id: string | null; email: string } | null;
  const email = (input.email ?? cur?.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BranchError('bad_email', 'Give the branch login a valid email address.');
  if (branch.owner_email && email === branch.owner_email.toLowerCase()) {
    throw new BranchError('owner_email', 'Use a different email from the owner’s — the owner opens branches from the owner panel.');
  }
  if (input.password !== undefined && input.password.length < 8) {
    throw new BranchError('weak_password', 'The password needs at least 8 characters.');
  }
  // A new login always gets a password; an edit only when one is asked for.
  const password = input.password ?? (!cur?.user_id || input.newPassword ? generatePassword() : null);

  const { data: cat } = await admin.from('permission_catalog').select('key');
  const permissions = ((cat ?? []) as { key: string }[]).map((c) => c.key).filter((k) => !HIDDEN_FROM_BRANCH(k)).sort();
  const app_metadata = { role: BRANCH_MANAGER, permissions };

  let userId = cur?.user_id ?? null;
  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      ...(email !== cur!.email ? { email, email_confirm: true } : {}),
      ...(password ? { password } : {}),
      app_metadata,
      ...(input.name !== undefined ? { user_metadata: { full_name: input.name } } : {}),
    });
    if (error) {
      if (/already|exists|registered/i.test(error.message)) throw new BranchError('email_in_use', 'That email already has a login in this branch.', 409);
      throw new BranchError('login_failed', error.message, 500);
    }
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: password!,
      email_confirm: true,
      app_metadata,
      user_metadata: input.name ? { full_name: input.name } : {},
    });
    if (error || !data?.user) {
      if (/already|exists|registered/i.test(error?.message ?? '')) throw new BranchError('email_in_use', 'That email already has a login in this branch.', 409);
      throw new BranchError('login_failed', error?.message ?? 'Could not create the login.', 500);
    }
    userId = data.user.id;
  }

  const row = { user_id: userId, email, role: BRANCH_MANAGER, status: 'active', ...(input.name !== undefined ? { full_name: input.name } : {}) };
  const { error: mErr } = cur
    ? await admin.from('memberships').update(row).eq('id', cur.id)
    : await admin.from('memberships').upsert(row, { onConflict: 'email' });
  if (mErr) throw new BranchError('login_failed', `membership: ${mErr.message}`, 500);
  return { email, password };
}

// ── Edit, archive, restore, delete ────────────────────────────────────────────

/** Rename a branch (its code and address stay; they are its identity). */
export async function renameBranch(parent: TenantRow, branch: TenantRow, name: string): Promise<TenantRow> {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 60) throw new BranchError('bad_name', 'Give the branch a name (2–60 characters).');
  const restaurantName = `${parent.restaurant_name} — ${clean}`;
  await supabaseAdmin.from('tenants').update({ restaurant_name: restaurantName, branch_name: clean }).eq('id', branch.id);
  if (branch.status === 'active') {
    // Receipts and reports in the branch read its own settings; best effort.
    const r = await resolveTenantClient(branch.slug);
    if (r.ok) await r.client.admin.from('business_settings').update({ restaurant_name: restaurantName }).eq('id', true);
  }
  return (await tenantBySlug(branch.slug)) ?? branch;
}

/**
 * Archive: the branch is switched off — nobody can sign in or order there and it leaves
 * the owner's figures — but its database and every record stay, and it can be restored.
 */
export async function archiveBranch(branch: TenantRow): Promise<TenantRow> {
  if (branch.status !== 'active') throw new BranchError('not_active', 'Only an active branch can be archived.', 409);
  await supabaseAdmin.from('tenants').update({ status: 'archived' }).eq('id', branch.id);
  return (await tenantBySlug(branch.slug)) ?? branch;
}

export async function restoreBranch(branch: TenantRow): Promise<TenantRow> {
  if (branch.status !== 'archived') throw new BranchError('not_archived', 'This branch is not archived.', 409);
  await supabaseAdmin.from('tenants').update({ status: 'active' }).eq('id', branch.id);
  return (await tenantBySlug(branch.slug)) ?? branch;
}

/**
 * Delete a branch for good: its Supabase project — and every order, stock movement and
 * finance record in it — is deleted, then its registry rows. Needs the branch code typed
 * back as confirmation. Cannot be undone.
 */
export async function deleteBranchPermanently(branch: TenantRow, confirmCode: string): Promise<void> {
  if (!branch.parent_tenant_id) throw new BranchError('not_a_branch', 'Only a branch can be deleted here.', 400);
  if (confirmCode.trim().toUpperCase() !== branch.branch_code) {
    throw new BranchError('confirm_mismatch', `Type the branch code (${branch.branch_code}) to confirm.`);
  }
  if (branch.status === 'provisioning') {
    throw new BranchError('busy', 'This branch is still being set up. Wait for it to finish or fail, then delete it.', 409);
  }
  const { data: proj } = await supabaseAdmin.from('tenant_projects').select('project_ref').eq('tenant_id', branch.id).maybeSingle();
  if (proj?.project_ref) {
    const conn = await getFreshConnection(branch.id);
    try {
      await mgmtClient(conn.access_token).deleteProject(String(proj.project_ref));
    } catch (err) {
      // Already gone in Supabase is fine; anything else stops before the registry is touched.
      if (!/-> 404|not found/i.test(String((err as Error).message))) {
        throw new BranchError('delete_failed', `Supabase did not delete the project: ${String((err as Error).message).slice(0, 300)}`, 502);
      }
    }
  }
  await supabaseAdmin.from('subscriptions').delete().eq('tenant_id', branch.id);
  // tenant_projects and the connection rows go with the tenant (on delete cascade).
  const { error } = await supabaseAdmin.from('tenants').delete().eq('id', branch.id);
  if (error) throw new BranchError('delete_failed', error.message, 500);
}

/** Supabase's free-plan project limit, said plainly (the raw API error is hard to act on). */
export function friendlySetupError(message: string | null): string | null {
  if (!message) return message;
  if (/maximum limits for the number of active free projects/i.test(message)) {
    return 'Your Supabase organization is on the free plan, which allows only 2 active projects, and it has reached that limit. In the Supabase dashboard, upgrade the organization or pause a project you don’t need, then click Retry.';
  }
  return message;
}

// ── The branch's own receipt details ──────────────────────────────────────────
// Every branch prints its OWN address, phone, email, website, tax number and footer on
// its receipts and invoices (business_settings in the branch's database). The receipt
// layout is copied once from the main restaurant; these details never are — they are
// different at every location — so the owner sets them per branch here.

export const RECEIPT_FIELDS = ['address', 'phone', 'contact_email', 'website', 'tax_registration_number', 'receipt_footer_text'] as const;
export type ReceiptDetails = Record<(typeof RECEIPT_FIELDS)[number], string | null>;

function cleanReceipt(input: Partial<ReceiptDetails> | undefined): Partial<ReceiptDetails> | null {
  if (!input) return null;
  const out: Partial<ReceiptDetails> = {};
  for (const k of RECEIPT_FIELDS) {
    const v = input[k] == null ? '' : String(input[k]).trim();
    if (v) out[k] = v;
  }
  if (out.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contact_email)) {
    throw new BranchError('bad_email', 'The receipt email does not look like an email address.');
  }
  return Object.keys(out).length ? out : null;
}

/** Write what the owner gave at creation into the now-ready branch, once (control-plane 0026). */
async function applyPendingSetup(branch: TenantRow): Promise<void> {
  const { data, error } = await supabaseAdmin.from('tenants').select('branch_setup').eq('id', branch.id).maybeSingle();
  if (error) return; // a control plane without 0026: nothing can be pending
  const setup = (data as { branch_setup?: { receipt?: Partial<ReceiptDetails> } | null } | null)?.branch_setup;
  if (!setup?.receipt) return;
  try {
    await setBranchReceipt(branch, setup.receipt);
    await supabaseAdmin.from('tenants').update({ branch_setup: null }).eq('id', branch.id);
  } catch (err) {
    // Kept for the next poll; the owner can also set them in Manage → Receipt details.
    console.error(`[branches] ${branch.slug}: receipt details not applied yet:`, (err as Error).message);
  }
}

export async function branchReceipt(branch: TenantRow): Promise<ReceiptDetails> {
  const admin = await branchAdmin(branch);
  const { data, error } = await admin.from('business_settings').select(RECEIPT_FIELDS.join(', ')).eq('id', true).maybeSingle();
  if (error) throw new BranchError('receipt_failed', error.message, 500);
  const row = (data ?? {}) as Partial<ReceiptDetails>;
  return Object.fromEntries(RECEIPT_FIELDS.map((k) => [k, row[k] ?? null])) as ReceiptDetails;
}

export async function setBranchReceipt(branch: TenantRow, input: Partial<ReceiptDetails>): Promise<ReceiptDetails> {
  const admin = await branchAdmin(branch);
  const patch: Partial<ReceiptDetails> = {};
  for (const k of RECEIPT_FIELDS) {
    if (input[k] === undefined) continue;
    const v = input[k] == null ? '' : String(input[k]).trim();
    patch[k] = v ? v : null;
  }
  if (patch.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.contact_email)) {
    throw new BranchError('bad_email', 'The receipt email does not look like an email address.');
  }
  if (Object.keys(patch).length) {
    const { error } = await admin.from('business_settings').update(patch).eq('id', true);
    if (error) throw new BranchError('receipt_failed', error.message, 500);
  }
  return branchReceipt(branch);
}
