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
import { PLANS, isPlanTier } from '@automation-restaurant/shared';

// Bump whenever tenant-template/schema.sql changes; matches the highest applied
// file in supabase/tenant-migrations/. v2 = promotions + purchasing + scheduling.
const SCHEMA_VERSION = 2;
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
    const existing = await supabaseAdmin
      .from('tenant_projects')
      .select('project_ref, project_url, service_key')
      .eq('tenant_id', tenantId)
      .maybeSingle();

    let projectUrl: string;
    let serviceKey: string;

    if (existing.data?.service_key) {
      projectUrl = existing.data.project_url;
      serviceKey = existing.data.service_key;
      console.log(`[provision] ${slug}: reusing project ${existing.data.project_ref}`);
    } else {
      const dbPassword = strongPassword();

      // Model B: the owner's own org via their OAuth token. Model A: the
      // platform org pool.
      let mgmt: MgmtClient;
      let project: CreatedProject;
      let organizationId: string;
      if (connected) {
        const conn = await getFreshConnection(tenantId);
        mgmt = mgmtClient(conn.access_token);
        organizationId = conn.organization_id;
        project = await mgmt.createProject({
          organizationId,
          name: `ar-${slug}`.slice(0, 56),
          dbPass: dbPassword,
        });
        console.log(
          `[provision] ${slug}: created project ${project.id} in owner org ${organizationId}, waiting for database…`,
        );
      } else {
        mgmt = platformMgmt;
        const picked = await createProjectInPool(`ar-${slug}`.slice(0, 56), dbPassword);
        project = picked.project;
        organizationId = picked.organizationId;
        console.log(
          `[provision] ${slug}: created project ${project.id} in org ${organizationId}, waiting for database…`,
        );
      }

      await mgmt.waitForQueryable(project.id);
      const keys = await mgmt.getApiKeys(project.id);

      console.log(`[provision] ${slug}: applying tenant schema…`);
      await mgmt.runSql(project.id, TENANT_SCHEMA_SQL);

      projectUrl = `https://${project.id}.supabase.co`;
      serviceKey = keys.service_role;
      const { error: regErr } = await supabaseAdmin.from('tenant_projects').upsert(
        {
          tenant_id: tenantId,
          project_ref: project.id,
          project_url: projectUrl,
          organization_id: organizationId,
          anon_key: keys.anon,
          service_key: keys.service_role,
          db_password: dbPassword,
          schema_version: SCHEMA_VERSION,
        },
        { onConflict: 'tenant_id' },
      );
      if (regErr) throw new Error(`registry insert failed: ${regErr.message}`);
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
      app_metadata: { role: 'owner' },
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
        app_metadata: { role: 'owner' },
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
    const planName =
      sub?.tier && isPlanTier(sub.tier) ? PLANS[sub.tier].name : (sub?.tier ?? 'Subscription');

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
  const planName =
    sub?.tier && isPlanTier(sub.tier) ? PLANS[sub.tier].name : (sub?.tier ?? 'Subscription');

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
