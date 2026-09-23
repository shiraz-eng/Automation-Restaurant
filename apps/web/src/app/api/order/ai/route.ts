import { NextResponse } from 'next/server';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

/**
 * Lightweight customer ordering assistant for when the Express backend
 * (apps/api/src/routes/customerAi.ts, with real tool-calling — deal
 * matching, item resolution, budget proposals as structured cards) isn't
 * reachable. Answers from the SAME menu/deals data already loaded on the
 * page (passed in the request body, not re-fetched) — plain text only, no
 * dealCards/resolvedCards/budgetCard (those need the tool-calling backend).
 * CustomerAiChat.tsx still renders correctly with only `reply` present.
 */
type MenuContextItem = { name: string; price_cents: number; category?: string | null; description?: string | null };
type MenuContextDeal = { name: string; price_cents: number; description?: string | null };

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const messages: Array<{ role: string; content: string }> = json.messages ?? [];
    const restaurantName: string = json.restaurant_name ?? 'this restaurant';
    const items: MenuContextItem[] = json.menu_items ?? [];
    const deals: MenuContextDeal[] = json.menu_deals ?? [];

    if (!messages.length) {
      return NextResponse.json({ reply: `How can I help with the ${restaurantName} menu today?` });
    }
    if (!GEMINI_API_KEY) {
      return NextResponse.json({
        reply: 'The ordering assistant is temporarily unavailable — browse the menu above, everything you need is right there.',
      });
    }

    const menuText = items
      .slice(0, 60)
      .map((i) => `- ${i.name}${i.category ? ` (${i.category})` : ''}: ${(i.price_cents / 100).toFixed(2)}${i.description ? ` — ${i.description}` : ''}`)
      .join('\n');
    const dealsText = deals.map((d) => `- ${d.name}: ${(d.price_cents / 100).toFixed(2)}${d.description ? ` — ${d.description}` : ''}`).join('\n');

    const systemPrompt = `You are the ordering assistant for ${restaurantName}. Answer questions about the menu below using only what's listed — never invent a dish, price, or deal. Keep answers short and friendly. You cannot add anything to the cart yourself; tell the customer to tap "Add" on the item.

MENU:
${menuText || '(no items listed)'}

DEALS:
${dealsText || '(no active deals)'}`;

    const contents = messages.slice(-10).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.5, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(12000),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'What would you like to know about the menu?';
      return NextResponse.json({ reply });
    }
    return NextResponse.json({ reply: 'Browse the categories above — everything on the menu is listed there.' });
  } catch {
    return NextResponse.json({ reply: "Sorry, I couldn't process that — try browsing the menu above." });
  }
}
