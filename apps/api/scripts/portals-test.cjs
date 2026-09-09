/* eslint-disable */
const { createClient } = require('@supabase/supabase-js');
const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

(async () => {
  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  const { data: tp } = await cp
    .from('tenant_projects')
    .select('project_url, service_key')
    .limit(1)
    .single();
  const svc = createClient(tp.project_url, tp.service_key, { auth: { persistSession: false } });
  const { data: item } = await svc.from('menu_items').select('id').eq('name', 'Garlic Bread').single();

  const res = await fetch('http://localhost:4000/api/public/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'bistro-nine',
      table: 'Table 9',
      guest_name: 'Kim',
      channel: 'dine_in',
      lines: [{ menu_item_id: item.id, qty: 2 }],
    }),
  });
  const o = await res.json();
  console.log('placed:', o);

  const UNPAID = ['pending', 'in_kitchen', 'ready', 'served'];
  const reg1 = await svc.from('orders').select('order_number,status,total_cents').in('status', UNPAID);
  console.log('register sees open bills:', reg1.data.map((r) => `#${r.order_number}(${r.status})`));

  await svc
    .from('orders')
    .update({ status: 'paid', payment_method: 'card', paid_at: new Date().toISOString() })
    .eq('id', o.order_id);
  const paid = await svc
    .from('orders')
    .select('order_number,status,payment_method,paid_at')
    .eq('id', o.order_id)
    .single();
  console.log('after take payment:', paid.data);

  const reg2 = await svc.from('orders').select('order_number').in('status', UNPAID).eq('id', o.order_id);
  console.log('register still lists this bill?', reg2.data.length > 0);

  process.exit(paid.data.status === 'paid' && paid.data.payment_method === 'card' ? 0 : 1);
})();
