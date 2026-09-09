import { NextResponse } from 'next/server';

// Same-origin proxy for the storefront promo-code preview (see /api/order).
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const subtotal = url.searchParams.get('subtotal') ?? '';
  if (!slug) return NextResponse.json({ error: 'missing_slug' }, { status: 400 });

  try {
    const qs = new URLSearchParams({ code, subtotal }).toString();
    const res = await fetch(
      `${API}/api/public/promo/${encodeURIComponent(slug)}?${qs}`,
      { headers: { Accept: 'application/json' } },
    );
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }
}
