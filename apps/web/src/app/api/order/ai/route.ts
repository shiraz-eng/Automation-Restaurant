import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Fast models in priority order. gemini-3.5-flash-lite and gemini-3.1-flash-lite
// answer in ~1-2s with minimal thinking; gemini-3.8-flash and 3.7-flash provide
// solid backups if the lighter models experience demand spikes.
const ORDER_AI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-flash-latest',
];

type MenuContextItem = {
  id?: string;
  name: string;
  price_cents: number;
  category?: string | null;
  description?: string | null;
};
type MenuContextDeal = {
  id?: string;
  name: string;
  price_cents: number;
  description?: string | null;
};
type DealCard = {
  deal_id: string;
  deal_name: string;
  status: string;
  individual_total_cents: number;
  deal_total_cents: number;
  savings_cents: number;
  missing?: string;
};
type ResolvedCard = {
  menu_item_id: string;
  item_name: string;
  variant_id: string | null;
  variant_name: string | null;
  available: boolean;
  modifier_option_ids: string[];
  resolved_modifiers: { name: string; price_cents: number }[];
  unit_price_cents: number | null;
};
type BudgetCard = {
  items: { variant_id: string; name: string; qty: number; unit_price_cents: number }[];
  deal: { deal_id: string; name: string; price_cents: number; qty: number } | null;
  subtotal_cents: number;
};

type InstantResult = {
  reply: string;
  dealCards?: DealCard[];
  resolvedCards?: ResolvedCard[];
  budgetCard?: BudgetCard;
};

/**
 * Instant local answers for common storefront ordering queries (greetings,
 * deals, best sellers, budget proposals, family/group recommendations).
 * Returns in < 5ms without burning API quota or waiting on network latency.
 */
function checkInstantResponse(
  query: string,
  restaurantName: string,
  items: MenuContextItem[],
  deals: MenuContextDeal[],
): InstantResult | null {
  const q = query.trim().toLowerCase();

  // 1. Greetings
  if (/^(hi|hello|hey|salam|assalam|aoa|good (morning|afternoon|evening))\b/i.test(q)) {
    const dealHighlight = deals.length > 0 ? ` Today's featured combo is **${deals[0]!.name}**!` : '';
    return {
      reply: `Hello! Welcome to **${restaurantName}**. I'm here to help you choose what to order — ask about our best sellers, current deals, or what fits your budget!${dealHighlight}`,
    };
  }

  // 2. Deals / Combos / Offers
  if (/best deal|what deal|any deal|deals|combos?|discount|offers?|specials?/i.test(q)) {
    if (deals.length > 0) {
      const cards: DealCard[] = deals.slice(0, 4).map((d) => ({
        deal_id: d.id || d.name,
        deal_name: d.name,
        status: 'eligible_now',
        individual_total_cents: Math.round(d.price_cents * 1.25),
        deal_total_cents: d.price_cents,
        savings_cents: Math.round(d.price_cents * 0.25),
      }));
      const list = deals
        .slice(0, 3)
        .map((d) => `- **${d.name}**: Rs. ${(d.price_cents / 100).toFixed(0)}${d.description ? ` (${d.description})` : ''}`)
        .join('\n');
      return {
        reply: `Here are our best combos and active deals right now:\n\n${list}\n\nTap **Use Deal** below to add any combo to your cart!`,
        dealCards: cards,
      };
    }
  }

  // 3. Best sellers / Popular / Recommendations
  if (/best seller|popular|recommend|most ordered|top dish|signature|favorites?/i.test(q)) {
    if (items.length > 0) {
      const topItems = items.slice(0, 4);
      const cards: ResolvedCard[] = topItems.map((it) => ({
        menu_item_id: it.id || it.name,
        item_name: it.name,
        variant_id: it.id || null,
        variant_name: null,
        available: true,
        modifier_option_ids: [],
        resolved_modifiers: [],
        unit_price_cents: it.price_cents,
      }));
      const list = topItems
        .map((it) => `- **${it.name}**: Rs. ${(it.price_cents / 100).toFixed(0)}${it.category ? ` (${it.category})` : ''}`)
        .join('\n');
      return {
        reply: `Here are our customer favorites and best sellers:\n\n${list}\n\nTap **Add to cart** on any item to order it!`,
        resolvedCards: cards,
      };
    }
  }

  // 4. Budget queries (e.g. "under 1000", "under 500", "under Rs 2000", "budget")
  const budgetMatch = q.match(/under\s+(?:rs\.?|pkr|\$)?\s*(\d+)/i) || q.match(/budget\s+(?:of\s+)?(?:rs\.?|pkr|\$)?\s*(\d+)/i);
  if (budgetMatch && budgetMatch[1]) {
    const budgetCents = parseInt(budgetMatch[1], 10) * 100;
    if (budgetCents > 0 && items.length > 0) {
      const affordable = items.filter((it) => it.price_cents <= budgetCents).sort((a, b) => b.price_cents - a.price_cents);
      const picked: { variant_id: string; name: string; qty: number; unit_price_cents: number }[] = [];
      let rem = budgetCents;
      for (const it of affordable) {
        if (it.price_cents <= rem) {
          picked.push({
            variant_id: it.id || it.name,
            name: it.name,
            qty: 1,
            unit_price_cents: it.price_cents,
          });
          rem -= it.price_cents;
          if (picked.length >= 3) break;
        }
      }
      if (picked.length > 0) {
        const subtotal = picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0);
        const card: BudgetCard = {
          items: picked,
          deal: null,
          subtotal_cents: subtotal,
        };
        const summary = picked.map((p) => `- 1× **${p.name}** (Rs. ${(p.unit_price_cents / 100).toFixed(0)})`).join('\n');
        return {
          reply: `Here is a great meal combination under Rs. ${budgetMatch[1]}:\n\n${summary}\n\n**Subtotal: Rs. ${(subtotal / 100).toFixed(0)}**\n\nTap **Add all to cart** below to order this combo!`,
          budgetCard: card,
        };
      }
    }
  }

  // 5. Group recommendation (e.g. "for 4 people", "four people", "family")
  if (/4 people|four people|family/i.test(q)) {
    const familyDeal = deals.find((d) => /family|feast|jumbo|mega|party|4/i.test(d.name)) || deals[0];
    if (familyDeal) {
      return {
        reply: `For 4 people, our top recommendation is the **${familyDeal.name}** (Rs. ${(familyDeal.price_cents / 100).toFixed(0)})${familyDeal.description ? ` — ${familyDeal.description}` : ''}! Tap **Use Deal** below to add it.`,
        dealCards: [
          {
            deal_id: familyDeal.id || familyDeal.name,
            deal_name: familyDeal.name,
            status: 'eligible_now',
            individual_total_cents: Math.round(familyDeal.price_cents * 1.3),
            deal_total_cents: familyDeal.price_cents,
            savings_cents: Math.round(familyDeal.price_cents * 0.3),
          },
        ],
      };
    }
  }

  return null;
}

/**
 * Races models with streamed response: tries the fast model first, races the
 * next model if no chunk arrives within 2 seconds, and drops thinking overhead
 * with minimal thinkingConfig.
 */
async function raceGeminiStream(
  models: string[],
  systemPrompt: string,
  contents: Array<{ role: string; parts: Array<{ text: string }> }>,
  onText: (chunk: string) => void,
): Promise<{ text: string; model: string }> {
  const HEDGE_MS = 2000;
  const TIMEOUT_MS = 14000;

  const tryCall = async (model: string, signal: AbortSignal, withThinking = true): Promise<Response> => {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 500,
        ...(withThinking ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
      },
    };

    let res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY as string },
        body: JSON.stringify(body),
        signal,
      },
    );

    // If model rejects thinkingLevel with 400, retry without thinkingConfig
    if (res.status === 400 && withThinking) {
      res = await tryCall(model, signal, false);
    }
    return res;
  };

  return new Promise((resolve, reject) => {
    let winner = -1;
    let settled = false;
    let started = 0;
    let failed = 0;
    let lastErr: unknown = new Error('No model available');
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const ctrls: AbortController[] = [];

    const cancelOthers = (keep: number) => ctrls.forEach((c, j) => j !== keep && c.abort());
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      fn();
    };

    const startNext = () => {
      if (settled || winner >= 0 || started >= models.length) return;
      const i = started++;
      const ctrl = new AbortController();
      ctrls[i] = ctrl;
      let timedOut = false;
      const kill = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, TIMEOUT_MS);

      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(startNext, HEDGE_MS);

      (async () => {
        const model = models[i]!;
        const res = await tryCall(model, ctrl.signal, true);
        if (!res.ok || !res.body) {
          throw new Error(`Model ${model} returned ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let full = '';
        let buf = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const evt = JSON.parse(payload) as {
                candidates?: { content?: { parts?: { text?: string }[] } }[];
                error?: { code?: number; message?: string };
              };
              if (evt.error) throw new Error(evt.error.message || 'Stream error');
              for (const part of evt.candidates?.[0]?.content?.parts ?? []) {
                if (part.text) {
                  if (winner < 0) {
                    winner = i;
                    clearTimeout(hedgeTimer);
                    cancelOthers(i);
                  }
                  if (winner === i) {
                    full += part.text;
                    onText(part.text);
                  }
                }
              }
            } catch {
              // Ignore partial JSON
            }
          }
        }
        return { text: full, model };
      })().then(
        (result) => {
          clearTimeout(kill);
          if (winner === i || winner < 0) {
            cancelOthers(i);
            finish(() => resolve(result));
          }
        },
        (err) => {
          clearTimeout(kill);
          if (winner === i) return finish(() => reject(err));
          if (ctrl.signal.aborted && !timedOut) return;
          failed++;
          lastErr = err;
          if (started < models.length) startNext();
          else if (failed === started && winner < 0) finish(() => reject(lastErr));
        },
      );
    };

    startNext();
  });
}

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const messages: Array<{ role: string; content: string }> = json.messages ?? [];
    const restaurantName: string = json.restaurant_name ?? 'this restaurant';
    const items: MenuContextItem[] = json.menu_items ?? [];
    const deals: MenuContextDeal[] = json.menu_deals ?? [];
    const wantsStream: boolean = json.stream === true;

    if (!messages.length) {
      const greeting = `How can I help with the ${restaurantName} menu today?`;
      if (wantsStream) {
        return new Response(`event: done\ndata: ${JSON.stringify({ reply: greeting })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }
      return NextResponse.json({ reply: greeting });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Check instant local answers first (< 5ms response, zero AI latency)
    const instant = checkInstantResponse(lastUser, restaurantName, items, deals);
    if (instant) {
      if (wantsStream) {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: instant.reply })}\n\n`));
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  reply: instant.reply,
                  dealCards: instant.dealCards ?? null,
                  resolvedCards: instant.resolvedCards ?? null,
                  budgetCard: instant.budgetCard ?? null,
                })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
          },
        });
      }
      return NextResponse.json(instant);
    }

    // Fallback if no Gemini API key configured
    if (!GEMINI_API_KEY) {
      const reply = 'The ordering assistant is temporarily unavailable — browse the menu above, everything you need is right there.';
      return NextResponse.json({ reply });
    }

    const menuText = items
      .slice(0, 60)
      .map((i) => `- ${i.name}${i.category ? ` (${i.category})` : ''}: Rs. ${(i.price_cents / 100).toFixed(0)}${i.description ? ` — ${i.description}` : ''}`)
      .join('\n');
    const dealsText = deals
      .map((d) => `- ${d.name}: Rs. ${(d.price_cents / 100).toFixed(0)}${d.description ? ` — ${d.description}` : ''}`)
      .join('\n');

    const systemPrompt = `You are the ordering assistant for ${restaurantName}. Answer questions about the menu below using only what's listed — never invent a dish, price, or deal. You may also answer general food questions (what a dish is, typical spice level, what goes well together) from your own knowledge; for allergies, say recipes vary and to confirm with staff. Reply in the guest's language, short and friendly, with **bold** dish names. You cannot add anything to the cart yourself; tell the customer to tap "Add" on the item.

MENU:
${menuText || '(no items listed)'}

DEALS:
${dealsText || '(no active deals)'}`;

    const contents = messages.slice(-10).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          let streamedText = '';
          try {
            const result = await raceGeminiStream(ORDER_AI_MODELS, systemPrompt, contents, (chunk) => {
              streamedText += chunk;
              controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`));
            });
            const reply = result.text.trim() || streamedText.trim() || 'What would you like to know about the menu?';
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  reply,
                  dealCards: null,
                  resolvedCards: null,
                  budgetCard: null,
                })}\n\n`,
              ),
            );
          } catch {
            // Model failure fallback: answer gracefully from loaded menu
            const fallbackReply = streamedText.trim()
              ? streamedText.trim()
              : `I'm having a little trouble connecting right now, but feel free to browse our categories above — our top dishes and deals are listed there!`;
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ reply: fallbackReply })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Non-streaming response
    let accumulated = '';
    try {
      const res = await raceGeminiStream(ORDER_AI_MODELS, systemPrompt, contents, (chunk) => {
        accumulated += chunk;
      });
      const reply = res.text.trim() || accumulated.trim() || 'What would you like to know about the menu?';
      return NextResponse.json({ reply });
    } catch {
      return NextResponse.json({
        reply: 'Browse the categories above — everything on the menu is listed there.',
      });
    }
  } catch {
    return NextResponse.json({ reply: "Sorry, I couldn't process that — try browsing the menu above." });
  }
}
