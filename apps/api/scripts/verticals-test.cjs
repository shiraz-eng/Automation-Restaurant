/* eslint-disable */
// End-to-end data-layer check for the three net-new verticals:
//   Promotions (discount applied through place_order),
//   Suppliers + Purchasing (receive_purchase_order restocks inventory),
//   Shifts + Attendance.
const { createClient } = require('@supabase/supabase-js');

const CP = 'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODk1NTQzNCwiZXhwIjoyMTA0NTMxNDM0fQ.8Pf3AAJ0MNn9LdcyWxvRARFx6EunjNWEBHj68JBKuP0';

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, cond) {
  log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

(async () => {
  const cp = createClient(CP, CP_SVC, { auth: { persistSession: false } });
  const { data: tp } = await cp
    .from('tenant_projects')
    .select('project_url, service_key, tenants!inner(slug)')
    .limit(1)
    .single();
  const slug = tp.tenants.slug;
  const svc = createClient(tp.project_url, tp.service_key, { auth: { persistSession: false } });
  log('tenant:', slug, tp.project_url);

  // ── Promotions ─────────────────────────────────────────────────────────
  const code = 'E2E' + Math.floor(Math.random() * 1e6);
  await svc.from('promotions').insert({
    name: 'E2E 20% off',
    kind: 'percent',
    value_bps: 2000,
    code,
    active: true,
  });
  const { data: item } = await svc
    .from('menu_items')
    .select('id, price_cents')
    .eq('is_available', true)
    .limit(1)
    .single();

  const order = await fetch('http://localhost:4000/api/public/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      guest_name: 'Promo E2E',
      channel: 'takeaway',
      promo_code: code,
      lines: [{ menu_item_id: item.id, qty: 2 }],
    }),
  }).then((r) => r.json());
  log('order response:', JSON.stringify(order));

  const expectedSub = item.price_cents * 2;
  const expectedDisc = Math.floor((expectedSub * 2000) / 10000);
  check('promo: subtotal correct', order.subtotal_cents === expectedSub);
  check('promo: 20% discount applied', order.discount_cents === expectedDisc && expectedDisc > 0);
  check(
    'promo: total = subtotal - discount + 8% tax',
    order.total_cents ===
      expectedSub - expectedDisc + Math.round(((expectedSub - expectedDisc) * 800) / 10000),
  );
  check('promo: promo_applied flag', order.promo_applied === true);

  // promo preview endpoint
  const preview = await fetch(
    `http://localhost:4000/api/public/promo/${slug}?code=${code}&subtotal=${expectedSub}`,
  ).then((r) => r.json());
  check('promo preview: valid code returns discount', preview.valid === true && preview.discount_cents === expectedDisc);
  const previewBad = await fetch(
    `http://localhost:4000/api/public/promo/${slug}?code=NOPE${code}&subtotal=${expectedSub}`,
  ).then((r) => r.json());
  check('promo preview: bad code => not valid', previewBad.valid === false && previewBad.discount_cents === 0);

  const bad = await fetch('http://localhost:4000/api/public/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      channel: 'takeaway',
      promo_code: 'NOPE-' + code,
      lines: [{ menu_item_id: item.id, qty: 1 }],
    }),
  }).then((r) => r.json());
  check('promo: invalid code => no discount, order still placed', bad.discount_cents === 0 && !!bad.order_id);

  await svc.from('promotions').delete().eq('code', code);

  // ── Suppliers + Purchasing ────────────────────────────────────────────
  const { data: sup } = await svc
    .from('suppliers')
    .insert({ name: 'E2E Wholesale', payment_terms: 'Net 30' })
    .select('id')
    .single();
  check('supplier created', !!sup?.id);

  let { data: inv } = await svc
    .from('inventory_items')
    .select('id, name, stock_qty')
    .limit(1)
    .maybeSingle();
  let createdInv = false;
  if (!inv) {
    const res = await svc
      .from('inventory_items')
      .insert({ name: 'E2E Flour', unit: 'kg', stock_qty: 0 })
      .select('id, name, stock_qty')
      .single();
    inv = res.data;
    createdInv = true;
  }
  const before = Number(inv.stock_qty);

  const { data: poNum } = await svc.rpc('next_po_number');
  const { data: po } = await svc
    .from('purchase_orders')
    .insert({ po_number: poNum, supplier_id: sup.id, status: 'sent' })
    .select('id')
    .single();
  await svc.from('purchase_order_lines').insert({
    purchase_order_id: po.id,
    inventory_item_id: inv.id,
    description: inv.name,
    qty: 25,
    unit_cost_cents: 130,
  });

  const { error: recvErr } = await svc.rpc('receive_purchase_order', { p_po_id: po.id });
  check('receive_purchase_order ran', !recvErr);

  const { data: invAfter } = await svc
    .from('inventory_items')
    .select('stock_qty')
    .eq('id', inv.id)
    .single();
  check('purchasing: stock increased by 25', Number(invAfter.stock_qty) === before + 25);

  const { data: poAfter } = await svc
    .from('purchase_orders')
    .select('status, received_at')
    .eq('id', po.id)
    .single();
  check('purchasing: PO marked received', poAfter.status === 'received' && !!poAfter.received_at);

  const { data: ledger } = await svc
    .from('stock_ledger')
    .select('reason, delta_qty, note')
    .eq('inventory_item_id', inv.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  check(
    'purchasing: restock ledger row written',
    ledger.reason === 'restock' && Number(ledger.delta_qty) === 25,
  );

  // idempotent re-receive should not double-count
  await svc.rpc('receive_purchase_order', { p_po_id: po.id });
  const { data: invAgain } = await svc
    .from('inventory_items')
    .select('stock_qty')
    .eq('id', inv.id)
    .single();
  check('purchasing: re-receive is a no-op', Number(invAgain.stock_qty) === before + 25);

  // cleanup purchasing
  await svc.from('purchase_orders').delete().eq('id', po.id);
  await svc.from('suppliers').delete().eq('id', sup.id);
  if (createdInv) {
    await svc.from('stock_ledger').delete().eq('inventory_item_id', inv.id);
    await svc.from('inventory_items').delete().eq('id', inv.id);
  } else {
    await svc.rpc('adjust_stock', {
      p_inventory_item_id: inv.id,
      p_delta: -25,
      p_reason: 'stock_take',
      p_note: 'E2E cleanup',
    });
  }

  // ── Shifts + Attendance ───────────────────────────────────────────────
  const { data: member } = await svc
    .from('memberships')
    .select('id')
    .limit(1)
    .single();

  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setHours(17, 0, 0, 0);
  const { data: shift, error: shiftErr } = await svc
    .from('shifts')
    .insert({
      membership_id: member.id,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      role_label: 'E2E cook',
    })
    .select('id')
    .single();
  check('shift created', !shiftErr && !!shift?.id);

  const { data: att } = await svc
    .from('attendance')
    .insert({ membership_id: member.id })
    .select('id, clock_in, clock_out')
    .single();
  check('attendance: clock-in open', !!att?.id && att.clock_out === null);
  await svc.from('attendance').update({ clock_out: new Date().toISOString() }).eq('id', att.id);
  const { data: attClosed } = await svc
    .from('attendance')
    .select('clock_out')
    .eq('id', att.id)
    .single();
  check('attendance: clock-out recorded', !!attClosed.clock_out);

  // cleanup scheduling
  await svc.from('shifts').delete().eq('id', shift.id);
  await svc.from('attendance').delete().eq('id', att.id);

  log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
