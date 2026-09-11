import { supabaseAdmin } from '../supabase';
import { tenantServiceClient } from './tenantAdmin';
import { sendEmail } from './mailer';

/**
 * AI Management's first deterministic automation (spec: "AI MANAGEMENT —
 * AUTOMATIC LOW-STOCK SUPPLIER EMAIL"). The trigger and eligibility are
 * decided entirely in SQL (app.sync_low_stock_event / public.
 * pending_low_stock_reorders — schema v25) — this module only composes and
 * sends the email, then records the honest result. Nothing here uses an AI
 * model; restaurant operations must never depend on one being reachable.
 */

type PendingReorder = {
  low_stock_event_id: string;
  inventory_item_id: string;
  item_name: string;
  unit: string;
  stock_qty: number;
  min_threshold: number;
  target_stock_qty: number;
  suggested_qty: number;
  supplier_id: string;
  supplier_name: string;
  supplier_email: string;
};

function composeLowStockEmail(restaurantName: string, r: PendingReorder) {
  const subject = `Low Stock Reorder Request — ${r.item_name}`;
  const text = [
    `Hello ${r.supplier_name},`,
    ``,
    `Our current stock of ${r.item_name} is at or below our configured reorder level.`,
    ``,
    `Item: ${r.item_name}`,
    `Current Stock: ${r.stock_qty} ${r.unit}`,
    `Reorder Level: ${r.min_threshold} ${r.unit}`,
    `Suggested Quantity: ${r.suggested_qty} ${r.unit}`,
    `Preferred Delivery: As soon as possible`,
    ``,
    `Restaurant: ${restaurantName}`,
    ``,
    `Please confirm availability, price, and expected delivery time.`,
    ``,
    `Regards,`,
    `${restaurantName}`,
    `Automation Restaurant`,
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1e21">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-weight:800;font-size:16px;margin-bottom:20px">${restaurantName}</div>
    <div style="background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:24px">
      <h1 style="font-size:16px;margin:0 0 12px">Low Stock Reorder Request</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px">Hello ${r.supplier_name}, our current stock of <strong>${r.item_name}</strong> is at or below our configured reorder level.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:0 0 18px">
        <tr><td style="padding:5px 0;color:#65676b">Current stock</td><td style="padding:5px 0;text-align:right;font-weight:600">${r.stock_qty} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Reorder level</td><td style="padding:5px 0;text-align:right;font-weight:600">${r.min_threshold} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Suggested quantity</td><td style="padding:5px 0;text-align:right;font-weight:700;color:#e8590c">${r.suggested_qty} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Preferred delivery</td><td style="padding:5px 0;text-align:right;font-weight:600">As soon as possible</td></tr>
      </table>
      <p style="font-size:13px;line-height:1.6;margin:0">Please confirm availability, price, and expected delivery time.</p>
    </div>
    <p style="font-size:12px;color:#65676b;margin:16px 0 0">${restaurantName} · sent by Automation Restaurant</p>
  </div></body></html>`;

  return { subject, text, html };
}

/** Runs the sweep for one tenant: fetch eligible reorders, send, record. */
export async function runLowStockSweepForTenant(tenantId: string): Promise<{ attempted: number; sent: number }> {
  const svc = await tenantServiceClient(tenantId);
  if (!svc) return { attempted: 0, sent: 0 };
  const { admin } = svc;

  const [{ data: tenantRow }, { data: pending, error: rpcErr }] = await Promise.all([
    supabaseAdmin.from('tenants').select('restaurant_name').eq('id', tenantId).maybeSingle(),
    admin.rpc('pending_low_stock_reorders'),
  ]);
  if (rpcErr) {
    console.error(`[low-stock] ${tenantId} pending_low_stock_reorders failed:`, rpcErr.message);
    return { attempted: 0, sent: 0 };
  }
  const rows = (pending ?? []) as PendingReorder[];
  if (rows.length === 0) return { attempted: 0, sent: 0 };
  const restaurantName = tenantRow?.restaurant_name ?? 'Automation Restaurant';

  let sent = 0;
  for (const r of rows) {
    const { subject, text, html } = composeLowStockEmail(restaurantName, r);
    const result = await sendEmail({ to: r.supplier_email, subject, text, html });
    const insert = {
      supplier_id: r.supplier_id,
      inventory_item_id: r.inventory_item_id,
      low_stock_event_id: r.low_stock_event_id,
      kind: 'low_stock_reorder' as const,
      subject,
      body: text,
      recipient_email: r.supplier_email,
      suggested_qty: r.suggested_qty,
      status: result.delivered ? ('sent' as const) : ('failed' as const),
      provider: result.provider,
      error: result.delivered ? null : result.provider === 'console' ? 'no email provider configured' : result.error,
      sent_at: result.delivered ? new Date().toISOString() : null,
    };
    const { error: insErr } = await admin.from('supplier_communications').insert(insert);
    if (insErr) {
      console.error(`[low-stock] ${tenantId} failed to record communication for ${r.item_name}:`, insErr.message);
      continue;
    }
    if (result.delivered) {
      sent += 1;
      console.log(`[low-stock] ${tenantId}: reorder email sent to ${r.supplier_name} for ${r.item_name} (${r.suggested_qty} ${r.unit})`);
    } else {
      console.log(`[low-stock] ${tenantId}: reorder email NOT delivered (${insert.error}) for ${r.item_name}`);
    }
  }
  return { attempted: rows.length, sent };
}

/** Sweeps every active tenant. One tenant's failure never stops the rest. */
export async function runLowStockSweepAllTenants(): Promise<void> {
  const { data: rows } = await supabaseAdmin.from('tenants').select('id, slug').eq('status', 'active');
  for (const t of (rows ?? []) as { id: string; slug: string }[]) {
    try {
      const { attempted, sent } = await runLowStockSweepForTenant(t.id);
      if (attempted > 0) console.log(`[low-stock] ${t.slug}: ${sent}/${attempted} reorder email(s) sent`);
    } catch (err) {
      console.error(`[low-stock] sweep error for ${t.slug}:`, err);
    }
  }
}
