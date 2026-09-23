import { NextResponse } from 'next/server';
import { getTenantConfig } from '@/lib/tenant';
import { createClient } from '@supabase/supabase-js';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') ?? '';
  const code = (url.searchParams.get('code') ?? '').trim();
  const subtotal = Number.parseInt(url.searchParams.get('subtotal') ?? '0', 10);
  if (!slug) return NextResponse.json({ error: 'missing_slug' }, { status: 400 });

  try {
    const qs = new URLSearchParams({ code, subtotal: String(subtotal) }).toString();
    const res = await fetch(
      `${API}/api/public/promo/${encodeURIComponent(slug)}?${qs}`,
      { headers: { Accept: 'application/json' } },
    );
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      return NextResponse.json(body, { status: res.status });
    }
  } catch {
    // Upstream API not running, execute directly against tenant Supabase
  }

  try {
    if (!code || !Number.isFinite(subtotal) || subtotal < 0) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 422 });
    }

    const config = await getTenantConfig(slug);
    if (!config) {
      return NextResponse.json({ error: 'restaurant_not_found' }, { status: 404 });
    }

    const client = createClient(config.url, config.anonKey);
    const { data, error } = await client.rpc('promo_preview', {
      p_code: code,
      p_subtotal_cents: subtotal,
    });

    if (error) {
      return NextResponse.json({ error: 'promo_check_failed' }, { status: 400 });
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return NextResponse.json({ valid: false, discount_cents: 0 });
    }

    return NextResponse.json({
      valid: true,
      kind: row.kind,
      discount_cents: row.discount_cents ?? 0,
    });
  } catch {
    return NextResponse.json({ valid: false, discount_cents: 0 });
  }
}
