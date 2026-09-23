import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const json = await req.json();
    // Fire-and-forget analytics event logging
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
