import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './supabase';
import { env } from './env';
import { createProject, waitForActive, getApiKeys, runSql } from './mgmt';
import { createClaimToken } from './lib/tokens';
import { sendOnboardingEmail } from './lib/mailer';

// Bump whenever tenant-template/schema.sql changes; matches the highest applied
// file in supabase/tenant-migrations/. v2 = promotions + purchasing + scheduling.
const SCHEMA_VERSION = 2;

// Bundled from supabase/tenant-template/schema.sql — the DDL for one restaurant's project.
const TENANT_SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../../supabase/tenant-template/schema.sql'),
  'utf8',
);

function strongPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Detached provisioning for one restaurant. Creates a dedicated Supabase
 * project, applies the tenant schema, records it, and emails the owner a claim
 * link. Any failure lands in tenants.provisioning_error and status='failed'.
 *
 * NOTE: fire-and-forget. Production should run this from a durable queue so a
 * crashed server doesn't leave a half-provisioned tenant.
 */
export async function provisionTenant(input: {
  tenantId: string;
  restaurantName: string;
  slug: string;
  ownerEmail: string;
  /** If supplied (checkout flow), the owner account is created immediately and
   *  no claim link is emailed. Otherwise a claim link is sent. */
  ownerPassword?: string;
  ownerName?: string;
}): Promise<void> {
  const { tenantId, restaurantName, slug, ownerEmail, ownerPassword, ownerName } = input;
  try {
    // Idempotency: skip if already provisioned.
    const existing = await supabaseAdmin
      .from('tenant_projects')
      .select('project_ref')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (existing.data) {
      console.log(`[provision] ${slug} already has project ${existing.data.project_ref}`);
      return;
    }

    const dbPassword = strongPassword();
    const project = await createProject(`ar-${slug}`.slice(0, 56), dbPassword);
    console.log(`[provision] ${slug}: created project ${project.id}, waiting for health…`);

    await waitForActive(project.id);
    const keys = await getApiKeys(project.id);

    console.log(`[provision] ${slug}: applying tenant schema…`);
    await runSql(project.id, TENANT_SCHEMA_SQL);

    const projectUrl = `https://${project.id}.supabase.co`;
    const { error: regErr } = await supabaseAdmin.from('tenant_projects').insert({
      tenant_id: tenantId,
      project_ref: project.id,
      project_url: projectUrl,
      anon_key: keys.anon,
      service_key: keys.service_role,
      db_password: dbPassword,
      schema_version: SCHEMA_VERSION,
    });
    if (regErr) throw new Error(`registry insert failed: ${regErr.message}`);

    if (ownerPassword) {
      // Checkout flow: create the owner account directly in the new project.
      const tenantAdmin = createClient(projectUrl, keys.service_role, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: created, error: userErr } = await tenantAdmin.auth.admin.createUser({
        email: ownerEmail.toLowerCase(),
        password: ownerPassword,
        email_confirm: true,
        app_metadata: { role: 'owner' },
        user_metadata: ownerName ? { full_name: ownerName } : {},
      });
      if (userErr || !created?.user) {
        throw new Error(`owner create failed: ${userErr?.message ?? 'no user'}`);
      }
      const { error: memErr } = await tenantAdmin.from('memberships').insert({
        user_id: created.user.id,
        email: ownerEmail.toLowerCase(),
        full_name: ownerName ?? null,
        role: 'owner',
        status: 'active',
      });
      if (memErr) throw new Error(`owner membership failed: ${memErr.message}`);

      await supabaseAdmin.from('tenants').update({ status: 'active' }).eq('id', tenantId);
      await sendOnboardingEmail(ownerEmail, `${env.APP_URL}/r/${slug}/login`);
      console.log(`[provision] ${slug}: done — owner account created, portal ready`);
    } else {
      // Stripe-webhook flow: email a single-use claim link to set the password.
      const { raw, hash } = createClaimToken();
      const expiresAt = new Date(
        Date.now() + env.ONBOARDING_TOKEN_TTL_MINUTES * 60_000,
      ).toISOString();
      const { error: tokErr } = await supabaseAdmin.from('onboarding_tokens').insert({
        tenant_id: tenantId,
        email: ownerEmail.toLowerCase(),
        token_hash: hash,
        expires_at: expiresAt,
      });
      if (tokErr) throw new Error(`token insert failed: ${tokErr.message}`);

      await supabaseAdmin.from('tenants').update({ status: 'active' }).eq('id', tenantId);
      await sendOnboardingEmail(ownerEmail, `${env.APP_URL}/onboarding/claim?token=${raw}`);
      console.log(`[provision] ${slug}: done — claim link sent to ${ownerEmail}`);
    }
  } catch (err) {
    console.error(`[provision] ${slug}: FAILED`, err);
    await supabaseAdmin
      .from('tenants')
      .update({ status: 'failed', provisioning_error: String((err as Error).message ?? err) })
      .eq('id', tenantId);
  }
}

export { SCHEMA_VERSION, TENANT_SCHEMA_SQL };
