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
  const { data: item } = await svc.from('menu_items').select('id').eq('name', 'Cola').single();

  const place = () =>
    fetch('http://localhost:4000/api/public/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'bistro-nine',
        table: 'Table 12',
        guest_name: 'Session Test',
        channel: 'dine_in',
        lines: [{ menu_item_id: item.id, qty: 1 }],
      }),
    }).then((r) => r.json());

  const a = await place();
  const b = await place();
  console.log('order A:', a.order_number, ' order B:', b.order_number);

  const { data: orders } = await svc
    .from('orders')
    .select('order_number, session_id, status')
    .in('id', [a.order_id, b.order_id]);
  console.log('orders:', orders);
  const sameSession = orders[0].session_id && orders[0].session_id === orders[1].session_id;
  console.log('both attached to the SAME open session?', sameSession);

  const { data: sess } = await svc
    .from('table_sessions')
    .select('id, status')
    .eq('id', orders[0].session_id)
    .single();
  console.log('session before close:', sess);

  await svc.rpc('close_session', { p_session_id: sess.id, p_payment_method: 'card' });

  const { data: after } = await svc
    .from('orders')
    .select('order_number, status, payment_method')
    .in('id', [a.order_id, b.order_id]);
  const { data: sess2 } = await svc
    .from('table_sessions')
    .select('status, closed_at')
    .eq('id', sess.id)
    .single();
  console.log('orders after close:', after);
  console.log('session after close:', sess2);

  const ok =
    sameSession &&
    after.every((o) => o.status === 'paid' && o.payment_method === 'card') &&
    sess2.status === 'closed';
  process.exit(ok ? 0 : 1);
})();
