/* eslint-disable */
const { createClient } = require('@supabase/supabase-js');

const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

(async () => {
  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  const { data: tp } = await cp
    .from('tenant_projects')
    .select('project_url, service_key, anon_key')
    .limit(1)
    .single();
  const { project_url: TURL, service_key: SVC, anon_key: ANON } = tp;

  const svc = createClient(TURL, SVC, { auth: { persistSession: false } });
  const anon = createClient(TURL, ANON, { auth: { persistSession: false } });

  const { data: item } = await svc
    .from('menu_items')
    .select('id')
    .eq('name', 'Margherita Pizza')
    .single();

  // 1. place order via the public API (as the storefront does)
  const res = await fetch('http://localhost:4000/api/public/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'bistro-nine',
      table: 'Table 5',
      guest_name: 'Dana',
      channel: 'dine_in',
      lines: [{ menu_item_id: item.id, qty: 1 }],
    }),
  });
  const order = await res.json();
  console.log('placed:', order);

  // 2. subscribe as the customer tracking page does (anon key)
  const events = [];
  const channel = anon
    .channel(`order-${order.order_id}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${order.order_id}` },
      (payload) => {
        events.push(payload.new.status);
        console.log('  realtime UPDATE -> status:', payload.new.status);
      },
    );
  await new Promise((resolve) => channel.subscribe((s) => s === 'SUBSCRIBED' && resolve()));
  console.log('subscribed to order channel');

  // 3. advance status as the kitchen would
  for (const status of ['ready', 'served']) {
    await new Promise((r) => setTimeout(r, 1200));
    await svc.from('orders').update({ status }).eq('id', order.order_id);
    console.log('kitchen set status =', status);
  }

  await new Promise((r) => setTimeout(r, 2000));
  console.log('\nrealtime events received by customer:', events);
  process.exit(events.length >= 2 ? 0 : 1);
})();
