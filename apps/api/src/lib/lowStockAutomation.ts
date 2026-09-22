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

/** The restaurant identity/branding this email should carry — sourced
 *  from the SAME business_settings row Brand Kit and receipt contact
 *  fields already use (spec §15: one identity source, not a separate
 *  "email branding" config). All optional: a restaurant that never
 *  opened Brand Kit still gets a correctly-branded email, just with the
 *  platform's default accent color and no logo. */
type RestaurantBranding = {
  contactEmail: string | null;
  logoUrl: string | null;
  primaryColor: string | null; // "R G B" channel string, same shape theme.ts uses
};

/** No email provider here can authenticate as an arbitrary restaurant
 *  address (Gmail SMTP rejects a From that isn't the authenticated
 *  account), so the technical From stays the platform's one verified
 *  sender — but the reply-to identity must never default to that
 *  platform mailbox either, since suppliers replying should reach the
 *  restaurant, not Automation Restaurant's own inbox. Falls back to the
 *  owner's real account email (tenants.owner_email — already stored at
 *  signup, not a new column) when the restaurant hasn't configured its
 *  own business contact_email. */
function resolveContactEmail(businessContactEmail: string | null, ownerEmail: string | null): string | null {
  return businessContactEmail ?? ownerEmail ?? null;
}

function composeLowStockEmail(restaurantName: string, branding: RestaurantBranding, r: PendingReorder) {
  const subject = `Low Stock Reorder Request — ${r.item_name}`;
  const accent = branding.primaryColor ? `rgb(${branding.primaryColor})` : '#e8590c';
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
    branding.contactEmail ? `Contact: ${branding.contactEmail}` : null,
    ``,
    `Please confirm availability, price, and expected delivery time.`,
    ``,
    `Regards,`,
    `${restaurantName}`,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const logoHtml = branding.logoUrl
    ? `<img src="${branding.logoUrl}" alt="${restaurantName}" style="max-height:40px;max-width:200px;display:block;margin-bottom:12px" />`
    : `<div style="font-weight:800;font-size:16px;margin-bottom:20px">${restaurantName}</div>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1e21">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px">
    ${logoHtml}
    <div style="background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:24px">
      <h1 style="font-size:16px;margin:0 0 12px">Low Stock Reorder Request</h1>
      <p style="font-size:14px;line-height:1.6;margin:0 0 16px">Hello ${r.supplier_name}, our current stock of <strong>${r.item_name}</strong> is at or below our configured reorder level.</p>
      <table style="font-size:13px;width:100%;border-collapse:collapse;margin:0 0 18px">
        <tr><td style="padding:5px 0;color:#65676b">Current stock</td><td style="padding:5px 0;text-align:right;font-weight:600">${r.stock_qty} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Reorder level</td><td style="padding:5px 0;text-align:right;font-weight:600">${r.min_threshold} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Suggested quantity</td><td style="padding:5px 0;text-align:right;font-weight:700;color:${accent}">${r.suggested_qty} ${r.unit}</td></tr>
        <tr><td style="padding:5px 0;color:#65676b">Preferred delivery</td><td style="padding:5px 0;text-align:right;font-weight:600">As soon as possible</td></tr>
      </table>
      <p style="font-size:13px;line-height:1.6;margin:0">Please confirm availability, price, and expected delivery time.</p>
      ${branding.contactEmail ? `<p style="font-size:12px;color:#65676b;margin:14px 0 0">Questions? Reply to this email or contact <a href="mailto:${branding.contactEmail}" style="color:${accent}">${branding.contactEmail}</a>.</p>` : ''}
    </div>
    <p style="font-size:11px;color:#9a9ea3;margin:16px 0 0">${restaurantName} · sent via Automation Restaurant</p>
  </div></body></html>`;

  return { subject, text, html };
}

/** Runs the sweep for one tenant: fetch eligible reorders, send, record. */
export async function runLowStockSweepForTenant(tenantId: string): Promise<{ attempted: number; sent: number }> {
  const svc = await tenantServiceClient(tenantId);
  if (!svc) return { attempted: 0, sent: 0 };
  const { admin } = svc;

  const [{ data: tenantRow }, { data: pending, error: rpcErr }, { data: settingsRow }] = await Promise.all([
    supabaseAdmin.from('tenants').select('restaurant_name, owner_email').eq('id', tenantId).maybeSingle(),
    admin.rpc('pending_low_stock_reorders'),
    // Same Brand Kit / contact fields the portal and receipts already
    // read (business_settings) — one restaurant identity source, not a
    // separate "email branding" config.
    admin.from('business_settings').select('contact_email, brand_logo_url, brand_primary').eq('id', true).maybeSingle(),
  ]);
  if (rpcErr) {
    console.error(`[low-stock] ${tenantId} pending_low_stock_reorders failed:`, rpcErr.message);
    return { attempted: 0, sent: 0 };
  }
  const rows = (pending ?? []) as PendingReorder[];
  if (rows.length === 0) return { attempted: 0, sent: 0 };
  const restaurantName = tenantRow?.restaurant_name ?? 'Automation Restaurant';
  const branding: RestaurantBranding = {
    contactEmail: resolveContactEmail(settingsRow?.contact_email ?? null, tenantRow?.owner_email ?? null),
    logoUrl: settingsRow?.brand_logo_url ?? null,
    primaryColor: settingsRow?.brand_primary ?? null,
  };

  let sent = 0;
  for (const r of rows) {
    const { subject, text, html } = composeLowStockEmail(restaurantName, branding, r);
    // From stays the platform's one verified/authorized address (env.
    // EMAIL_FROM) — only its display name changes to the restaurant, per
    // spec §8: never send From an address the provider hasn't verified.
    // Reply-To is the restaurant's own configured contact email where set,
    // so the supplier's reply reaches the restaurant, not the platform.
    const result = await sendEmail({
      to: r.supplier_email,
      subject,
      text,
      html,
      fromName: restaurantName,
      replyTo: branding.contactEmail,
    });
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
