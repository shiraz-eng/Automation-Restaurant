import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase';
import { env } from './env';
import { platformMgmt } from './mgmt';
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

function mailStatus(r: MailResult): 'sent' | 'skipped' | 'failed' {
  if (r.delivered) return 'sent';
  return r.provider === 'console' ? 'skipped' : 'failed';
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
}): Promise<void> {
  const { tenantId, restaurantName, slug, ownerEmail, ownerName } = input;

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
      const project = await platformMgmt.createProject({
        organizationId: env.SUPABASE_ORG_ID,
        name: `ar-${slug}`.slice(0, 56),
        dbPass: dbPassword,
      });
      console.log(`[provision] ${slug}: created project ${project.id}, waiting for database…`);
      await platformMgmt.waitForQueryable(project.id);
      const keys = await platformMgmt.getApiKeys(project.id);

      console.log(`[provision] ${slug}: applying tenant schema…`);
      await platformMgmt.runSql(project.id, TENANT_SCHEMA_SQL);

      projectUrl = `https://${project.id}.supabase.co`;
      serviceKey = keys.service_role;
      const { error: regErr } = await supabaseAdmin.from('tenant_projects').upsert(
        {
          tenant_id: tenantId,
          project_ref: project.id,
          project_url: projectUrl,
          anon_key: keys.anon,
          service_key: keys.service_role,
          db_password: dbPassword,
          schema_version: SCHEMA_VERSION,
        },
        { onConflict: 'tenant_id' },
      );
      if (regErr) throw new Error(`registry insert failed: ${regErr.message}`);
    }

    // Owner account in the restaurant's own project. Random password unless one
    // was supplied; the welcome email carries a secure set-password link.
    const tenantAdmin = createClient(projectUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const password = input.ownerPassword ?? strongPassword();
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
      const { data: list } = await tenantAdmin.auth.admin.listUsers();
      userId = list.users.find((u) => u.email?.toLowerCase() === ownerEmail.toLowerCase())?.id;
      if (!userId) throw new Error('owner user exists but could not be resolved');
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
    await provisionTenant({
      tenantId: t.id,
      restaurantName: t.restaurant_name,
      slug: t.slug,
      ownerEmail: t.owner_email,
      ownerName: t.owner_name ?? undefined,
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

  const mail = await sendWelcomeEmail({
    to: t.owner_email,
    restaurantName: t.restaurant_name,
    ownerName: t.owner_name,
    planName,
    billingInterval: sub?.billing_interval ?? 'monthly',
    portalUrl: `${env.APP_URL}/r/${t.slug}/login`,
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
