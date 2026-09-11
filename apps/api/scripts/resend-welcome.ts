import { createClient } from '@supabase/supabase-js';
import { env } from '../src/env';
import { resendWelcomeEmail } from '../src/provisioning';

const slug = process.argv[2] || 'kfc';

const cp = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

(async () => {
  const { data, error } = await cp
    .from('tenants')
    .select('id, owner_email, status')
    .eq('slug', slug)
    .maybeSingle();
  if (error || !data) {
    console.error('tenant not found:', slug, error?.message ?? '');
    process.exit(1);
  }
  console.log(`resending welcome email for "${slug}" -> ${data.owner_email} (status: ${data.status})`);
  const result = await resendWelcomeEmail(data.id);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.delivered ? 0 : 2);
})();
