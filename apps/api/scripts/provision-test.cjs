/**
 * Provision one restaurant end-to-end, bypassing Stripe.
 * Usage:  node apps/api/scripts/provision-test.cjs "Bistro Nine" owner@bistronine.test
 * Requires: control-plane migration applied; SUPABASE_ACCESS_TOKEN + SUPABASE_ORG_ID in apps/api/.env.
 */
const { supabaseAdmin } = require('../dist/supabase');
const { provisionTenant } = require('../dist/provisioning');

(async () => {
  const name = process.argv[2] || 'Bistro Nine';
  const email = process.argv[3] || 'owner@bistronine.test';
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  console.log(`registering "${name}" (${slug}) …`);
  const { data, error } = await supabaseAdmin.rpc('register_tenant', {
    p_restaurant_name: name,
    p_slug: slug,
    p_tier: 'growth',
    p_billing_interval: 'monthly',
    p_status: 'active',
    p_stripe_customer_id: null,
    p_stripe_subscription_id: 'sub_test_' + Date.now(),
    p_current_period_end: null,
    p_owner_email: email,
    p_region: process.env.SUPABASE_REGION || 'us-east-1',
  });
  if (error) {
    console.error('register_tenant failed:', error.message);
    process.exit(1);
  }
  const row = Array.isArray(data) ? data[0] : data;
  console.log('registered tenant', row.tenant_id, 'slug', row.slug);

  await provisionTenant({
    tenantId: row.tenant_id,
    restaurantName: name,
    slug: row.slug,
    ownerEmail: email,
  });

  const { data: dir } = await supabaseAdmin
    .from('tenant_directory')
    .select('*')
    .eq('slug', row.slug)
    .maybeSingle();
  console.log('tenant_directory:', dir);
})();
