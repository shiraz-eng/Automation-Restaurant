import { NextResponse } from 'next/server';

// Same-origin proxy: the browser posts here, this forwards to the Express API
// server-side so the storefront never deals with CORS or the API's URL.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

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
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }
}
