import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase';
import { env, supabaseOrgPool } from './env';
import { platformMgmt, mgmtClient, type CreatedProject, type MgmtClient } from './mgmt';
import { getFreshConnection } from './lib/supabaseOAuth';
import { tenantServiceClient } from './lib/tenantAdmin';
import { createClaimToken } from './lib/tokens';
import { sendWelcomeEmail, type MailResult } from './lib/mailer';
import { getPlanByTier } from './lib/plans';
import { syncEntitlementsForTenant } from './lib/entitlementSync';

// Bump whenever tenant-template/schema.sql changes; matches the highest applied
// file in supabase/tenant-migrations/.
//   v3 permissions foundation · v4 portals · v5 menu variants
//   v6 Operations Portal RBAC (permission-gated RLS + expanded catalog)
//   v7 roles as objects + presets + set_member_access
//   v8 staff permission back-fill (no-op on a fresh project)
//   v9 payments / refunds / order_adjustments + cashier RPCs
//   v10 Kitchen Portal — customer notes, kitchen status RPCs, food availability
//   v11 Attendance Portal — business/attendance settings, check-in/out RPCs
//   v12 Deals & combos — deals / deal_components, deal-aware place_order
//   v13 audit attribution (portal_id) + order-lifecycle audit + daily_closings
//   v14 hardening — set_member_access JWT-derived + service-role-only, force-pw RPC
//   v15 place_order() atomic qty-tracked availability decrement (fixes an
//       oversell race on menu_variants/deals.available_qty); record_waste()
//       now flips is_available off when it drains a tracked variant to zero
//   v16 feedback.ambiance category
//   v17 guest-readable checkout-portal names (order-ready "go to the counter")
//   v18 modifier_groups/modifier_options + place_order() prices & validates them
//   v19 menu-images storage bucket (public read, staff write)
//   v20 recipe-based inventory: variant/modifier-aware recipe explosion,
//       weighted-average ingredient costing, per-order-line cost snapshot,
//       waste/stock-count RPCs, partial PO receiving, kitchen->counter routing
//   v21 COGS & profitability engine: stock_ledger cost-basis snapshot,
//       expenses table, order/period/item/deal profitability + menu
//       engineering RPCs — one authoritative calc layer for Finance page + AI
//   v22 Supplier & payables engine: supplier price catalog + history, PO
//       approval gate, accept/reject receiving, supplier invoices, 3-way
//       matching with tolerance, payment holds, credit notes, payments with
//       multi-invoice allocation, supplier_payable()/supplier_statement()
//   v23 Dashboard sales trend: sales_by_day()/sales_by_hour() for the
//       monthly line chart + day drill-down, built on app.day_sales()
//   v24 Dashboard visuals: revenue_by_category()/payment_mix()/
//       feedback_summary() for the KPI row, mix pie charts and customer-
//       experience card (top products/attendance reuse existing RPCs)
//   v25 AI Management's first automation: low_stock_events (deterministic
//       trigger, open/resolve, one-open-per-item), supplier_communications
//       log, pending_low_stock_reorders() eligibility RPC
//   v26 Deals: Build-Your-Own-Combo — deal_option_groups/deal_option_items
//       (min/max-select option groups with upcharges) layered on top of
//       existing fixed-price deals; place_order() validates/prices/
//       inserts selections and explodes their recipes exactly like plain
//       menu items
//   v27 Promotions v2: happy-hour scheduling (days_of_week/start_time/
//       end_time), usage_limit_total with an atomic usage_count redemption
//       guard, promotion_redemptions log, and promotion_performance() —
//       one authoritative calc layer for the Promotions page + AI
//   v28 Auto-apply promotions: promotions.auto_apply +
//       best_auto_promotion() — place_order() applies the single best
//       eligible auto_apply promotion itself when no code was entered (or
//       the one entered didn't validate), so a scheduled happy-hour promo
//       actually fires on its own instead of needing a typed code
//   v29 BOGO promotions: app.promo_kind gains 'bogo'; promotions gains
//       bogo_menu_item_id/bogo_buy_qty/bogo_get_qty/bogo_get_discount_bps;
//       bogo_discount_for_order() computes the discount from the order's
//       own lines (cheapest qualifying units first) since BOGO needs to
//       know what was actually bought, not just the subtotal; place_order()
//       resolves an explicit code's promotion ONCE (via the new shared
//       app.promotion_is_valid_now()) and branches on kind. Code-required
//       in v1 — auto-apply BOGO is deferred (needs cart contents,
//       best_auto_promotion() only ever sees a subtotal)
//   v30 Recipe Management: recipes/recipe_versions/recipe_ingredients/
//       recipe_cost_log — a named, versioned, statused authoring layer
//       ABOVE recipe_components (which stays exactly what place_order()
//       reads, untouched). activate_recipe_version() resolves sub-recipes
//       (semi_finished/preparation types) down to raw inventory quantities
//       and syncs them into recipe_components; snapshot_recipe_cost_
//       changes() logs cost drift from ingredient price changes alone.
//       Existing recipe_components rows backfilled into "Version 1, Active"
//       recipes so nothing pre-existing loses its consumption definition.
//   v31 AI menu import: menu_import_drafts (extracted_json/diff_json/
//       status) + a private 'menu-imports' storage bucket for uploaded
//       source documents. Applying a draft writes to the same menu_*
//       tables the manual Menu page uses — no AI-only menu store.
//   v32 AI Approval Inbox: ai_pending_actions persists every AI-proposed
//       action (not just the one confirmed inline in the proposing chat)
//       so any authorized approver can see and act on it centrally.
//   v33 Exception lifecycle: exception_states lets a manager acknowledge/
//       resolve/ignore an item from the Exception Center, keyed on the
//       exception's own category+message text (it has no row of its own).
//   v34 AI Inventory Import: inventory_import_drafts + a generic
//       'ai-imports' bucket — the document-to-draft pattern proven a
//       second time (menu was the first), reusing aiDocumentEngine.ts.
//   v35 AI Recipe/Table/Supplier Import: three more domains on the same
//       shared engine. recipe_import_drafts (applies only through
//       create_recipe() — never a raw insert), table_import_drafts and
//       supplier_import_drafts (both create-only). Broadens the
//       'ai-imports' bucket's RLS beyond inventory's own permissions so
//       all three can actually use it.
//   v36 AI Supplier Price/PO/Staff Import: three more domains.
//       supplier_price_import_drafts (price changes go through
//       set_supplier_item_price(), new catalog pairings are a plain
//       insert), po_import_drafts (creates draft POs only when every
//       line already has a price on file with that supplier, mirroring
//       draft_purchase_order), staff_import_drafts (the one domain that
//       creates real login credentials — exact role matching against the
//       fixed creatable-role list, plus the same anti-escalation check
//       POST /api/staff/access uses; an existing email is never touched).
//       Broadens the 'ai-imports' bucket's RLS once more.
//   v37 Export audit trail: export_audit_log — one row per generated
//       PDF/Excel report (Restaurant Performance & Owner Activity
//       Intelligence spec §39), written by the API after each export
//       succeeds or fails. Records exports only; report content is never
//       stored, every report regenerates fresh each time.
//   v38 Permanent report storage: a private 'reports' storage bucket, plus
//       export_audit_log.storage_path/domain — a generated PDF/Excel is
//       still always computed fresh, now also saved so it can be
//       re-downloaded later without regenerating. domain distinguishes a
//       per-section export (Suppliers/Purchasing/Inventory/Orders/
//       Expenses) from the full multi-section report.
//   v39 export_audit_log update policy — lets the client patch a PDF
//       export's row with storage_path after it renders and uploads the
//       file (the row itself was inserted server-side earlier, before the
//       PDF bytes existed).
//   v40 Social media integration (Instagram): social_accounts (one
//       connected Instagram Business account, via Facebook Login for
//       Business OAuth) and social_posts (a draft/approval queue —
//       draft_social_post proposes one, a manager separately approves and
//       publishes it; nothing posts automatically). Four new social.*
//       permission_catalog keys, granted to manager by default (owner
//       already has '*').
//   v41 Configurable refund approval policy: business_settings gains
//       max_refund_without_approval_cents (null = unrestricted, today's
//       behavior unchanged); refund_payment() now requires
//       payments.approve_refund (or can_write()) for any refund over
//       that threshold. New payments.approve_refund key, granted to
//       manager by default.
//   v42 Owner/Manager portal separation: removed the can_write()/
//       is_staff() manager-or-any-staff bypass from payments/refunds
//       reads, business_settings writes, expenses, and the Recipes &
//       Food Cost domain (recipes/recipe_versions/recipe_ingredients/
//       recipe_cost_log/recipe_import_drafts + the 4 recipe RPCs) — each
//       now requires the actual has_perm() grant, so the Owner's Portal
//       & Access Control configuration genuinely restricts a manager
//       instead of the role name silently overriding it. Also removed
//       can_write() from public.roles' own write policy (a manager could
//       previously edit their own role's permissions array directly,
//       bypassing /api/staff/access's anti-escalation check) and added
//       protect_owner_only_permissions, a trigger that rejects '*' on
//       any role row except 'owner' even for a caller who does hold
//       roles.update.
//   v43 Narrows the live 'manager' role's default permissions to exclude
//       payments.refund/approve_refund/adjust/reconcile, finance.view,
//       inventory.manage_recipes/view_cost, and portals.view —
//       subtractive (removes exactly these keys from whatever the
//       role's current array is), so any prior Owner customization to
//       'manager' survives untouched. Matches 0042's new default in
//       schema.sql; 0042 alone only removed the can_write() bypass that
//       made this restriction meaningless.
//   v44 Wires public.portal_staff (existed since v4, never read by
//       anything) into the actual permission pipeline:
//       app.membership_effective_permissions(role, extra, membership_id) =
//       role preset ∪ extra_permissions ∪ every linked portal's
//       permissions; set_member_access now folds it in too, so a role
//       change never silently drops portal-derived access. New RPCs
//       set_portal_staff (replace a portal's assigned staff list) and
//       membership_effective_permissions (recompute one membership after
//       its portal or role changes) — both service_role-only, both
//       re-check the caller's own permissions before letting them grant
//       what they don't hold. Linking the Super Admin portal is refused
//       outright.
//   v45 Receipt customization (business_settings.receipt_logo_url/
//       receipt_footer_text/receipt_template_html) + a 'branding' storage
//       bucket for the logo (public read, settings.update write) +
//       expenses.supplier_id so an expense can optionally be tied to a
//       real supplier record.
//   v46 Restaurant Brand Kit: renames business_settings.receipt_logo_url
//       to brand_logo_url (one general-purpose logo, also used on
//       receipts/PDFs) and adds brand_primary/brand_primary_fg/
//       brand_bg_main/brand_bg_surface/brand_border/brand_text_body/
//       brand_text_muted/brand_radius/brand_appearance — the same token
//       shape apps/web/src/lib/theme.ts's ThemeTokens already defines,
//       now persisted per-tenant instead of per-browser localStorage.
//       Adds public.get_brand_kit(), a SECURITY DEFINER RPC exposing only
//       these visual-identity columns to anon/authenticated, so a guest
//       storefront/customer AI can render the restaurant's look without
//       broader business_settings access (refund policy, receipt text).
//   v47 portals.email — mirrors a kiosk portal login's real auth.users
//       email (source of truth stays auth.users; every write path updates
//       it there first) so Portal Management can list/edit it without an
//       admin API round trip per row, the same way `permissions` already
//       mirrors app_metadata.
//   v48 Configurable receipt template: business_settings.receipt_config
//       (structured, section-based receipt layout — which sections
//       appear, in what order, which fields within each, custom text
//       blocks, thermal width/divider style) plus the restaurant contact
//       fields (address/phone/contact_email/website/
//       tax_registration_number) its "Restaurant Information" section
//       needs, none of which existed in this schema before. Null
//       receipt_config falls back to the pre-existing receipt_footer_text/
//       receipt_template_html behavior unchanged.
//   v49 Portal identity: business_settings.meta_title (the browser <title>
//       every portal page and sub-page inherits, via Next.js title
//       templates — null falls back to the restaurant's own name) and
//       get_brand_kit() extended to return it, so the portal layouts that
//       need it for metadata read it through the same one Brand Kit path.
//   v50 Kitchen stations: menu_items.station (free-text prep-station
//       assignment — Fryer/Grill/Drinks/...). Null = unassigned. Powers
//       the redesigned Kitchen Operations board's station filter; no new
//       table, same grouped-free-text pattern menu_categories established.
//   v51 app.sync_order_lines_status() trigger — keeps order_lines.
//       kds_status in sync with orders.status on every write path, not
//       just the kitchen_* RPCs (which already did this manually); fixes
//       a real desync the Orders page's direct status write caused, since
//       it's independently permissioned (orders.update) from the RPCs
//       (kitchen.update_status) so routing it through them would silently
//       break status changes for a custom portal holding only one.
//   v52 Recipe-driven product availability engine: product_availability
//       (derived AVAILABLE/LOW_STOCK/UNAVAILABLE status + producible_qty +
//       bottleneck ingredient per menu_item/variant that has a recipe) and
//       availability_audit_log (immutable transition history). Layered on
//       TOP of the existing manual is_available/track_availability/
//       available_qty toggles, not replacing them. Dependency-aware
//       triggers recalc only the affected (item, variant) pairs whenever
//       inventory_items.stock_qty, recipe_components, modifier_recipe_
//       components, or a required modifier_option's availability changes —
//       mirrors low_stock_events' own trigger-driven, one-subject-at-a-time
//       shape (0025). get_product_availability_detail() exposes the
//       per-ingredient breakdown; recalculate_all_product_availability()
//       backfills existing tenants (nothing is tracked until it first runs).
//   v53 Portal sign-in/out tracking (portals.last_logout_at +
//       portal_record_sign_in/out(), logged to audit_logs) and a
//       per-staff default shift_start_time (memberships) that
//       app.recompute_attendance() falls back to for late detection when
//       no explicit shifts row exists that day. attendance_auto_absent_
//       sweep() marks a past business day 'absent' (source='auto') for
//       anyone expected in who never clocked in or got an explicit
//       status — swept periodically by the API server, same pattern as
//       the low-stock/recipe-cost automations.
//   v54 Recipe/Menu Inventory Consumption Priority: product_priority
//       (critical/high/medium/low level + drag-and-drop rank per level)
//       and a priority-ordered shared-ingredient allocation waterfall
//       (app.recalc_priority_allocation, priority_stock_pool scratch
//       table). Extracted the availability engine's own calculation
//       (app.compute_product_capacity) and write (app.apply_product_
//       availability_result) into shared helpers so the plain per-
//       product engine and the priority waterfall share ONE
//       implementation rather than duplicating it. No-op — zero
//       behavior change — until an Owner actually sets a priority.
//   v55 Plan entitlements: business_settings.plan_tier/plan_features,
//       synced from the control-plane subscription by
//       apps/api/src/lib/entitlementSync.ts (Stripe webhook + admin plan
//       edits), plus a trigger blocking brand_* writes when menu.branded
//       isn't in the current plan — the one feature with a real write
//       surface worth enforcing at the DB level.
//   v56 adjust_stock() auto-links a manual restock to a single unambiguous
//       open PO line for that item (same weighted-average costing and
//       status transition as receive_purchase_order_line()) so purchasing
//       reflects a delivery recorded from the Inventory page too, not only
//       via "Receive PO".
//   v57 permission_catalog gains type (read/write/approval/export) and
//       risk_level (normal/high) metadata for Portal Management's selected-
//       permission summary, plus the two keys already enforced server-side
//       but missing from the catalog (inventory.manage,
//       inventory.manage_purchases).
//   v58 Every Create Portal permission option enforced server-side: per-
//       operation RLS (tables/deals/variants/purchases/suppliers/roles/
//       portals), payment adjust + reconciliation, cash counts, ingredient
//       cost RPC, attendance dashboard/history/corrections, review
//       response/moderation/analytics, customers, member access list, and
//       anti-escalation triggers on portals and roles.
//   v59 Customers, Roles & Access and permissions.view retired from the
//       permission catalog (sections removed from the product).
//   v60 Food availability automation: Priority Allocation ON/OFF setting,
//       scoped (connected-ingredient) waterfall instead of whole-restaurant,
//       order lines checked against the allocated quantity, kitchen dish
//       waste through recipe ingredients, item take-off-sale switch.
//   v61 get_priority_allocation_enabled() for availability.view holders.
//   v62 Priority-level percentage allocation (priority_level_allocation,
//       set_priority_level_allocation, percentage rounds + redistribution
//       inside app.recalc_priority_allocation).
//   v63 SECURITY: app.can_write()/app.has_perm() never return NULL — a
//       portal login used to slip past  if not (has_perm or can_write())
//       guards.
//   v64 Deals & Combos workspace: deal type/status/ref, schedule (days +
//       time window), rules (min/max per order, usage limit), channels,
//       customer display fields; order-time rule enforcement; performance,
//       availability, cost-estimate and live-deal RPCs; deal images.
//   v65 Fair allocation inside a priority level: a level's share is split
//       evenly between its products (every size), and products with no
//       priority count as Low.
//   v66 Legacy per-size manual food counters retired (they still blocked
//       orders and showed Sold Out after the Food Stock panel was removed).
//   v67 delete_recipe(): permanently delete a recipe (refused while another
//       recipe uses it as a sub-recipe).
const SCHEMA_VERSION = 67;
const MAX_ATTEMPTS = 5;

// Bundled from supabase/tenant-template/schema.sql — the DDL for one restaurant's project.
const TENANT_SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../../supabase/tenant-template/schema.sql'),
  'utf8',
);

function strongPassword(): string {
  return randomBytes(24).toString('base64url');
}

/** Human-typeable temporary password for the welcome email, e.g. "Kqmx-rp29-9wab". */
function readablePassword(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = '23456789';
  const pick = (s: string, k: number) => {
    const bytes = randomBytes(k);
    let out = '';
    for (let i = 0; i < k; i++) out += s.charAt((bytes[i] as number) % s.length);
    return out;
  };
  return `${pick(A, 1)}${pick(a, 3)}-${pick(a, 2)}${pick(n, 2)}-${pick(n, 1)}${pick(a, 3)}`;
}

function mailStatus(r: MailResult): 'sent' | 'skipped' | 'failed' {
  if (r.delivered) return 'sent';
  return r.provider === 'console' ? 'skipped' : 'failed';
}

/** A free org that's at its 2-project cap answers project creation with this. */
function isOrgAtCapacity(message: string): boolean {
  return /maximum limits for the number of active free projects|free project limit|2 project limit/i.test(
    message,
  );
}

/**
 * Create the project in the first pooled org that has room. On free tier each
 * org caps at 2 projects; when one is full we move to the next. On a paid plan
 * the pool is just one org and the loop runs once.
 */
async function createProjectInPool(
  name: string,
  dbPass: string,
): Promise<{ project: CreatedProject; organizationId: string }> {
  const tried: string[] = [];
  for (const organizationId of supabaseOrgPool) {
    try {
      const project = await platformMgmt.createProject({ organizationId, name, dbPass });
      return { project, organizationId };
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      tried.push(`${organizationId}: ${msg.slice(0, 120)}`);
      if (!isOrgAtCapacity(msg)) throw err; // a real error — don't mask it
      console.warn(`[provision] org ${organizationId} at capacity, trying next…`);
    }
  }
  throw new Error(
    `every Supabase org in the pool is at capacity — add another id to SUPABASE_ORG_IDS. Tried: ${tried.join(' | ')}`,
  );
}

/** Best-effort column write — tolerates a control plane that hasn't had the
 *  welcome_email_* migration (0006) applied yet. */
async function patchTenant(tenantId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('tenants').update(patch).eq('id', tenantId);
  if (error && /column .* does not exist/i.test(error.message)) {
    const { welcome_email_status, welcome_email_sent_at, welcome_email_error, provisioning_attempts, ...core } =
      patch;
    void welcome_email_status;
    void welcome_email_sent_at;
    void welcome_email_error;
    void provisioning_attempts;
    if (Object.keys(core).length) await supabaseAdmin.from('tenants').update(core).eq('id', tenantId);
  }
}

/**
 * Detached provisioning for one restaurant, run ONLY after a Stripe webhook has
 * verified payment. Creates a dedicated Supabase project in the platform org,
 * applies the tenant schema, creates the owner account + a set-password link,
 * and sends the branded welcome email. Any failure lands in
 * tenants.provisioning_error with status='failed' for the retry sweep.
 *
 * NOTE: fire-and-forget. Production should run this from a durable queue.
 */
export async function provisionTenant(input: {
  tenantId: string;
  restaurantName: string;
  slug: string;
  ownerEmail: string;
  ownerName?: string;
  /** Optional preset password; otherwise a random one is set and the owner
   *  chooses their real password via the welcome email's secure link. */
  ownerPassword?: string;
  /** Model B: create the project in the owner's own Supabase org using the
   *  OAuth grant in supabase_connections, instead of the platform org pool. */
  connected?: boolean;
}): Promise<void> {
  const { tenantId, restaurantName, slug, ownerEmail, ownerName, connected } = input;

  try {
    await supabaseAdmin
      .from('tenants')
      .update({ status: 'provisioning', provisioning_error: null })
      .eq('id', tenantId);

    // Idempotency: reuse an existing project if provisioning half-completed.
    // The registry row is written as soon as the project exists — BEFORE the
    // schema is applied below — specifically so a schema failure (a bad
    // migration, a transient API error, ...) leaves a resumable row instead
    // of an unregistered orphan that would make every retry collide with
    // Supabase's "project with this name already exists".
    const existing = await supabaseAdmin
      .from('tenant_projects')
      .select('project_ref, project_url, organization_id, service_key, db_password, schema_version')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    let projectUrl: string;
    let serviceKey: string;

    if (existing.data?.service_key && existing.data.schema_version === SCHEMA_VERSION) {
      projectUrl = existing.data.project_url;
      serviceKey = existing.data.service_key;
      console.log(`[provision] ${slug}: reusing project ${existing.data.project_ref}`);
    } else {
      const dbPassword = existing.data?.db_password ?? strongPassword();

      // Model B: the owner's own org via their OAuth token. Model A: the
      // platform org pool.
      let mgmt: MgmtClient;
      let projectRef: string;
      let organizationId: string;
      if (existing.data?.project_ref) {
        // A previous attempt created (and registered) the project but never
        // got through schema application — resume on that SAME project
        // rather than asking Supabase for a new one, which would just be
        // rejected as a duplicate name.
        projectRef = existing.data.project_ref;
        organizationId = existing.data.organization_id ?? '';
        mgmt = connected ? mgmtClient((await getFreshConnection(tenantId)).access_token) : platformMgmt;
        console.log(`[provision] ${slug}: resuming project ${projectRef}, re-applying schema…`);
      } else if (connected) {
        const conn = await getFreshConnection(tenantId);
        mgmt = mgmtClient(conn.access_token);
        organizationId = conn.organization_id;
        const project = await mgmt.createProject({
          organizationId,
          name: `ar-${slug}`.slice(0, 56),
          dbPass: dbPassword,
        });
        projectRef = project.id;
        console.log(
          `[provision] ${slug}: created project ${projectRef} in owner org ${organizationId}, waiting for database…`,
        );
      } else {
        mgmt = platformMgmt;
        const picked = await createProjectInPool(`ar-${slug}`.slice(0, 56), dbPassword);
        projectRef = picked.project.id;
        organizationId = picked.organizationId;
        console.log(
          `[provision] ${slug}: created project ${projectRef} in org ${organizationId}, waiting for database…`,
        );
      }

      await mgmt.waitForQueryable(projectRef);
      const keys = await mgmt.getApiKeys(projectRef);
      projectUrl = `https://${projectRef}.supabase.co`;

      const { error: regErr } = await supabaseAdmin.from('tenant_projects').upsert(
        {
          tenant_id: tenantId,
          project_ref: projectRef,
          project_url: projectUrl,
          organization_id: organizationId || null,
          anon_key: keys.anon,
          service_key: keys.service_role,
          db_password: dbPassword,
        },
        { onConflict: 'tenant_id' },
      );
      if (regErr) throw new Error(`registry insert failed: ${regErr.message}`);

      console.log(`[provision] ${slug}: applying tenant schema…`);
      await mgmt.runSql(projectRef, TENANT_SCHEMA_SQL);

      serviceKey = keys.service_role;
      const { error: verErr } = await supabaseAdmin
        .from('tenant_projects')
        .update({ schema_version: SCHEMA_VERSION })
        .eq('tenant_id', tenantId);
      if (verErr) throw new Error(`schema_version update failed: ${verErr.message}`);
    }

    // Owner account in the restaurant's own project. A readable temporary
    // password goes in the welcome email (owner changes it after first login);
    // the email also carries a secure set-password link.
    const tenantAdmin = createClient(projectUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const tempPassword = input.ownerPassword ?? readablePassword();
    const password = tempPassword;
    const { data: created, error: userErr } = await tenantAdmin.auth.admin.createUser({
      email: ownerEmail.toLowerCase(),
      password,
      email_confirm: true,
      app_metadata: { role: 'owner', permissions: ['*'] },
      user_metadata: ownerName ? { full_name: ownerName } : {},
    });
    let userId = created?.user?.id;
    if (userErr || !userId) {
      if (!/already (been )?registered|already exists|email_exists/i.test(userErr?.message ?? '')) {
        throw new Error(`owner create failed: ${userErr?.message ?? 'no user'}`);
      }
      // Re-run: reset the existing owner's password to the new temp one so the
      // welcome email stays accurate.
      const { data: list } = await tenantAdmin.auth.admin.listUsers();
      userId = list.users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase())?.id;
      if (!userId) throw new Error('owner user exists but could not be resolved');
      await tenantAdmin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        app_metadata: { role: 'owner', permissions: ['*'] },
      });
    }
    const { error: memErr } = await tenantAdmin.from('memberships').upsert(
      {
        user_id: userId,
        email: ownerEmail.toLowerCase(),
        full_name: ownerName ?? null,
        role: 'owner',
        status: 'active',
      },
      { onConflict: 'email' },
    );
    if (memErr) throw new Error(`owner membership failed: ${memErr.message}`);

    // Push this tenant's plan entitlements into its own project (0055) —
    // has to happen here, not in the Stripe webhook, since the project
    // doesn't exist yet when the webhook first fires.
    try {
      await syncEntitlementsForTenant(tenantId);
    } catch (err) {
      console.error(`[provision] ${slug}: entitlement sync failed:`, err);
    }

    // Secure single-use set-password link for the welcome email.
    let setupUrl: string | null = null;
    if (!input.ownerPassword) {
      const { raw, hash } = createClaimToken();
      const expiresAt = new Date(
        Date.now() + env.ONBOARDING_TOKEN_TTL_MINUTES * 60_000,
      ).toISOString();
      await supabaseAdmin.from('onboarding_tokens').insert({
        tenant_id: tenantId,
        email: ownerEmail.toLowerCase(),
        token_hash: hash,
        expires_at: expiresAt,
      });
      setupUrl = `${env.APP_URL}/onboarding/claim?token=${raw}`;
    }

    // Workspace is ready → activate, THEN send the welcome email.
    await supabaseAdmin.from('tenants').update({ status: 'active' }).eq('id', tenantId);

    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('tier, billing_interval')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const planName = sub?.tier ? ((await getPlanByTier(sub.tier))?.name ?? sub.tier) : 'Subscription';

    const mail = await sendWelcomeEmail({
      to: ownerEmail,
      restaurantName,
      ownerName,
      planName,
      billingInterval: sub?.billing_interval ?? 'monthly',
      portalUrl: `${env.APP_URL}/r/${slug}/login`,
      tempPassword: input.ownerPassword ? null : tempPassword,
      setupUrl,
    });
    await patchTenant(tenantId, {
      welcome_email_status: mailStatus(mail),
      welcome_email_sent_at: new Date().toISOString(),
      welcome_email_error: mail.delivered ? null : ('error' in mail ? mail.error : 'no provider configured'),
    });
    console.log(
      `[provision] ${slug}: done — portal ready, welcome email ${mailStatus(mail)} (${mail.provider})`,
    );
  } catch (err) {
    console.error(`[provision] ${slug}: FAILED`, err);
    const { data: t } = await supabaseAdmin
      .from('tenants')
      .select('provisioning_attempts')
      .eq('id', tenantId)
      .maybeSingle();
    await patchTenant(tenantId, {
      status: 'failed',
      provisioning_error: String((err as Error).message ?? err),
      provisioning_attempts: ((t as { provisioning_attempts?: number } | null)?.provisioning_attempts ?? 0) + 1,
    });
  }
}

/**
 * Server-side retry sweep: re-attempt tenants stuck in 'failed' up to
 * MAX_ATTEMPTS. Started from server.ts on an interval.
 */
export async function retryFailedProvisions(): Promise<void> {
  const { data: rows } = await supabaseAdmin
    .from('tenants')
    .select('id, restaurant_name, slug, owner_email, owner_name, provisioning_attempts')
    .eq('status', 'failed')
    .limit(5);
  for (const t of (rows ?? []) as Array<{
    id: string;
    restaurant_name: string;
    slug: string;
    owner_email: string;
    owner_name: string | null;
    provisioning_attempts: number | null;
  }>) {
    if ((t.provisioning_attempts ?? 0) >= MAX_ATTEMPTS) continue;
    console.log(`[provision] retry sweep -> ${t.slug} (attempt ${(t.provisioning_attempts ?? 0) + 1})`);
    const { data: conn } = await supabaseAdmin
      .from('supabase_connections')
      .select('tenant_id')
      .eq('tenant_id', t.id)
      .maybeSingle();
    await provisionTenant({
      tenantId: t.id,
      restaurantName: t.restaurant_name,
      slug: t.slug,
      ownerEmail: t.owner_email,
      ownerName: t.owner_name ?? undefined,
      connected: Boolean(conn),
    });
  }
}

/** Re-send the welcome email for an already-active tenant (admin action). */
export async function resendWelcomeEmail(tenantId: string): Promise<MailResult> {
  const { data: t, error } = await supabaseAdmin
    .from('tenants')
    .select('restaurant_name, slug, owner_email, owner_name, status')
    .eq('id', tenantId)
    .maybeSingle();
  if (error || !t) throw new Error('tenant not found');
  if (t.status !== 'active') throw new Error(`tenant is ${t.status}, not active`);

  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('tier, billing_interval')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const planName = sub?.tier ? ((await getPlanByTier(sub.tier))?.name ?? sub.tier) : 'Subscription';

  const { raw, hash } = createClaimToken();
  await supabaseAdmin.from('onboarding_tokens').insert({
    tenant_id: tenantId,
    email: t.owner_email.toLowerCase(),
    token_hash: hash,
    expires_at: new Date(Date.now() + env.ONBOARDING_TOKEN_TTL_MINUTES * 60_000).toISOString(),
  });

  // Reset the owner password to a fresh temp one so the resent email is usable.
  let tempPassword: string | null = readablePassword();
  try {
    const svc = await tenantServiceClient(tenantId);
    if (svc) {
      const { data: list } = await svc.admin.auth.admin.listUsers();
      const u = list.users.find(
        (x) => x.email?.toLowerCase() === t.owner_email.toLowerCase(),
      );
      if (u) {
        await svc.admin.auth.admin.updateUserById(u.id, {
          password: tempPassword,
          email_confirm: true,
        });
      } else {
        tempPassword = null;
      }
    } else {
      tempPassword = null;
    }
  } catch (e) {
    console.error('[provision] resend: password reset failed:', e);
    tempPassword = null;
  }

  const mail = await sendWelcomeEmail({
    to: t.owner_email,
    restaurantName: t.restaurant_name,
    ownerName: t.owner_name,
    planName,
    billingInterval: sub?.billing_interval ?? 'monthly',
    portalUrl: `${env.APP_URL}/r/${t.slug}/login`,
    tempPassword,
    setupUrl: `${env.APP_URL}/onboarding/claim?token=${raw}`,
  });
  await patchTenant(tenantId, {
    welcome_email_status: mailStatus(mail),
    welcome_email_sent_at: new Date().toISOString(),
    welcome_email_error: mail.delivered ? null : ('error' in mail ? mail.error : 'no provider configured'),
  });
  return mail;
}

export { SCHEMA_VERSION, TENANT_SCHEMA_SQL };
