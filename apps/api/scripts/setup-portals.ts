import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { env } from '../src/env';
import { tenantServiceClientBySlug } from '../src/lib/tenantAdmin';

const slug = process.argv[2] || 'kfc';

function tempPw(): string {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const n = '23456789';
  const pick = (s: string, k: number) => {
    const b = randomBytes(k);
    let o = '';
    for (let i = 0; i < k; i++) o += s.charAt((b[i] as number) % s.length);
    return o;
  };
  return `${pick(a.toUpperCase(), 1)}${pick(a, 3)}-${pick(a, 2)}${pick(n, 2)}-${pick(n, 1)}${pick(a, 3)}`;
}

const PRESETS: Record<string, string[]> = {
  kitchen: [
    'kitchen.view', 'kitchen.update_status', 'kitchen.manage_availability',
    'kitchen.record_waste', 'availability.update', 'orders.view',
  ],
  attendance: [
    'attendance.view', 'attendance.mark', 'attendance.check_in', 'attendance.check_out',
    'attendance.view_dashboard', 'attendance.view_reports', 'staff.view',
  ],
  checkout: [
    'payments.view', 'payments.accept', 'orders.view', 'orders.create',
    'orders.apply_discount', 'receipts.view', 'receipts.print',
  ],
};

(async () => {
  const svc = await tenantServiceClientBySlug(slug);
  if (!svc) throw new Error(`no tenant / not ready: ${slug}`);
  const { admin } = svc;

  // 1. owner password
  const cp = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: t } = await cp.from('tenants').select('owner_email').eq('slug', slug).maybeSingle();
  const ownerPw = tempPw();
  const { data: list } = await admin.auth.admin.listUsers();
  const owner = list.users.find((u) => u.email?.toLowerCase() === t?.owner_email?.toLowerCase());
  if (owner) {
    await admin.auth.admin.updateUserById(owner.id, { password: ownerPw, email_confirm: true });
  }

  const out: Record<string, unknown>[] = [
    { portal: 'OWNER (Operations)', url: `${env.APP_URL}/r/${slug}/login`, email: t?.owner_email, password: ownerPw },
  ];

  // 2. one portal per type
  for (const [type, permissions] of Object.entries(PRESETS)) {
    const routeKey = type;
    const { data: existing } = await admin
      .from('portals')
      .select('id, portal_user_id')
      .eq('route_key', routeKey)
      .maybeSingle();

    let portalId = existing?.id as string | undefined;
    if (!portalId) {
      const { data: p, error } = await admin
        .from('portals')
        .insert({ name: type[0].toUpperCase() + type.slice(1), type, route_key: routeKey, permissions, force_pw_change: false })
        .select('id')
        .single();
      if (error) throw new Error(`create ${type}: ${error.message}`);
      portalId = p.id;
    } else {
      await admin.from('portals').update({ permissions, force_pw_change: false }).eq('id', portalId);
    }

    const email = `${routeKey}@${slug}.portal`;
    const password = tempPw();
    let userId = existing?.portal_user_id as string | undefined;
    if (userId) {
      await admin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        app_metadata: { kind: 'portal', portal_id: portalId, portal_route: routeKey, permissions },
      });
    } else {
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { kind: 'portal', portal_id: portalId, portal_route: routeKey, permissions },
      });
      if (error || !created?.user) throw new Error(`user ${type}: ${error?.message}`);
      userId = created.user.id;
      await admin.from('portals').update({ portal_user_id: userId }).eq('id', portalId);
    }

    out.push({ portal: type, url: `${env.APP_URL}/r/${slug}/portal/${routeKey}`, email, password });
  }

  console.log(`\nPortal logins for "${slug}":\n`);
  console.table(out);
  process.exit(0);
})();
