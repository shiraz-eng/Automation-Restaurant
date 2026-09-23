import { NextResponse } from 'next/server';
import { getTenantConfig } from '@/lib/tenant';
import { createClient } from '@supabase/supabase-js';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TAX_RATE_BPS = 800;

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  try {
    const res = await fetch(`${API}/api/public/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(body, { status: res.status });
    }
  } catch {
    // Upstream API not running, execute directly against tenant Supabase
  }

  try {
    const { slug, table, guest_name, channel, promo_code, customer_note, lines } = payload;
    if (!slug || !lines || !Array.isArray(lines) || lines.length === 0) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 422 });
    }

    const config = await getTenantConfig(slug);
    if (!config) {
      return NextResponse.json({ error: 'restaurant_not_found' }, { status: 404 });
    }

    const client = createClient(config.url, config.anonKey);
    const { data, error } = await client.rpc('place_order', {
      p_channel: channel || 'dine_in',
      p_table_label: table ?? null,
      p_customer_name: guest_name ?? null,
      p_tax_rate_bps: TAX_RATE_BPS,
      p_lines: lines,
      p_promo_code: promo_code ?? null,
      p_customer_note: customer_note ?? null,
    });

    if (error) {
      return NextResponse.json({ error: 'order_failed', message: error.message }, { status: 400 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(
      {
        order_id: row.order_id,
        order_number: row.order_number,
        subtotal_cents: row.subtotal_cents,
        discount_cents: row.discount_cents,
        total_cents: row.total_cents,
        promo_applied: (row.discount_cents ?? 0) > 0,
      },
      { status: 201 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'internal_error';
    return NextResponse.json({ error: 'order_failed', message }, { status: 500 });
  }
}
