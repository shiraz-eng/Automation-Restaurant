import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Fast models in priority order: flash-lite models start streaming in ~1-2s,
// backed by flash models if there is a demand spike.
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

/**
 * Dynamically scans the AI's natural response to detect any dishes or deals
 * that were recommended or highlighted, and returns structured action cards
 * so the guest gets interactive one-tap "Add to cart" / "Use Deal" buttons.
 */
function extractDynamicCards(
  reply: string,
  items: MenuContextItem[],
  deals: MenuContextDeal[],
): { dealCards: DealCard[] | null; resolvedCards: ResolvedCard[] | null } {
  const boldMatches = Array.from(reply.matchAll(/\*\*([^*]+)\*\*/g)).map((m) => m[1]!.trim().toLowerCase());
  const replyLower = reply.toLowerCase();

  const matchedCards: ResolvedCard[] = [];
  const matchedDeals: DealCard[] = [];

  // Match items mentioned or bolded in the dynamic AI text
  for (const item of items) {
    const itemNameLower = item.name.toLowerCase();
    const isBolded = boldMatches.some((b) => b === itemNameLower || b.includes(itemNameLower) || itemNameLower.includes(b));
    const isMentioned = replyLower.includes(itemNameLower);

    if (isBolded || (isMentioned && matchedCards.length < 3)) {
      if (!matchedCards.some((c) => c.item_name.toLowerCase() === itemNameLower)) {
        matchedCards.push({
          menu_item_id: item.id || item.name,
          item_name: item.name,
          variant_id: item.id || null,
          variant_name: null,
          available: true,
          modifier_option_ids: [],
          resolved_modifiers: [],
          unit_price_cents: item.price_cents,
        });
      }
    }
    if (matchedCards.length >= 3) break;
  }

  // Match deals mentioned or bolded in the dynamic AI text
  for (const deal of deals) {
    const dealNameLower = deal.name.toLowerCase();
    const isBolded = boldMatches.some((b) => b === dealNameLower || b.includes(dealNameLower) || dealNameLower.includes(b));
    const isMentioned = replyLower.includes(dealNameLower);

    if (isBolded || (isMentioned && matchedDeals.length < 2)) {
      if (!matchedDeals.some((d) => d.deal_name.toLowerCase() === dealNameLower)) {
        matchedDeals.push({
          deal_id: deal.id || deal.name,
          deal_name: deal.name,
          status: 'eligible_now',
          individual_total_cents: Math.round(deal.price_cents * 1.25),
          deal_total_cents: deal.price_cents,
          savings_cents: Math.round(deal.price_cents * 0.25),
        });
      }
    }
    if (matchedDeals.length >= 2) break;
  }

  return {
    dealCards: matchedDeals.length > 0 ? matchedDeals : null,
    resolvedCards: matchedCards.length > 0 ? matchedCards : null,
  };
}

/**
 * Builds dynamic budget cards if the user specifically asked for an order under a budget.
 */
function extractDynamicBudget(
  lastUserMsg: string,
  items: MenuContextItem[],
): BudgetCard | null {
  const q = lastUserMsg.toLowerCase();
  const match = q.match(/under\s+(?:rs\.?|pkr|\$|€|£)?\s*(\d+)/i) || q.match(/budget\s+(?:of\s+)?(?:rs\.?|pkr|\$|€|£)?\s*(\d+)/i);
  if (!match || !match[1]) return null;

  const budgetCents = parseInt(match[1], 10) * 100;
  if (budgetCents <= 0 || items.length === 0) return null;

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

  if (picked.length === 0) return null;

  return {
    items: picked,
    deal: null,
    subtotal_cents: picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0),
  };
}

/**
 * Races models with streamed response: tries the fastest model first, races the
 * next model if no chunk arrives within 2 seconds, and uses minimal thinkingConfig.
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
        temperature: 0.5,
        maxOutputTokens: 600,
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
    const categories: string[] = Array.isArray(json.menu_categories) ? json.menu_categories : [];
    const wantsStream: boolean = json.stream === true;

    if (!messages.length) {
      const greeting = `Hello! How can I help you choose from the ${restaurantName} menu today?`;
      if (wantsStream) {
        return new Response(`event: done\ndata: ${JSON.stringify({ reply: greeting })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }
      return NextResponse.json({ reply: greeting });
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Fallback if no Gemini API key configured
    if (!GEMINI_API_KEY) {
      const reply = `Welcome to **${restaurantName}**! Browse our categories above to view all dishes and deals, or let us know if you need any assistance.`;
      if (wantsStream) {
        return new Response(`event: done\ndata: ${JSON.stringify({ reply })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }
      return NextResponse.json({ reply });
    }

    const categoriesText = categories.length > 0
      ? categories.join(', ')
      : Array.from(new Set(items.map((i) => i.category).filter(Boolean))).join(', ');

    const menuText = items
      .slice(0, 100)
      .map((i) => `- ${i.name}${i.category ? ` [Category: ${i.category}]` : ''}: ${(i.price_cents / 100).toFixed(2)}${i.description ? ` — ${i.description}` : ''}`)
      .join('\n');
    const dealsText = deals
      .map((d) => `- ${d.name}: ${(d.price_cents / 100).toFixed(2)}${d.description ? ` — ${d.description}` : ''}`)
      .join('\n');

    // Generic, dynamic ChatGPT-style concierge prompt with strict menu grounding
    const systemPrompt = `You are the AI dining concierge and ordering assistant for ${restaurantName}, operating dynamically and conversationally just like ChatGPT.

Persona & Dynamic Style:
- Talk like ChatGPT: intelligent, witty when fitting, warm, perceptive, and completely natural. Never sound robotic, canned, or script-like.
- Adapt fluidly to the guest's language, tone, and vibe: English, Urdu, Roman Urdu ("kya hal hai", "bhai koi mast cheez batao"), Arabic, Spanish, French, casual banter, or formal dining inquiries.
- Give mouth-watering, descriptive details: explain flavor profiles (smoky, crispy, savory, creamy, tangy), textures, and aromas using the real items and descriptions on our menu.
- Suggest delicious food pairings dynamically (e.g. recommend a refreshing drink or side from our menu that complements their chosen main).
- You may answer general culinary or food questions from broad knowledge (e.g. explaining what an ingredient is, differences in cooking styles, dietary definitions like halal or gluten-free).

CRITICAL ANTI-HALLUCINATION & MENU GROUNDING RULES:
1. ONLY RECOMMEND WHAT IS ON THE MENU:
   - You may ONLY suggest, recommend, or mention dishes, platters, combos, sides, or drinks that are EXPLICITLY listed in the MENU or ACTIVE DEALS below.
   - NEVER invent, hallucinate, or assume dishes, cuisines, or platter types that the restaurant does not serve.
   - Specifically, NEVER suggest generic items like "BBQ platters", "curries", "kebabs", "platters to share", "pasta", "pizza", or "tacos" UNLESS those exact items or categories are explicitly present in the MENU or ACTIVE DEALS below.
2. GROUP & SHARING RECOMMENDATIONS:
   - When asked for group recommendations (e.g. "What would you recommend for 4 people?", "recommend dinner for a family"):
   - Look strictly at the MENU and ACTIVE DEALS below.
   - If there is an active deal or combo that fits (or multiple deals), recommend that!
   - Otherwise, select 2 to 4 real, specific dishes from the MENU, propose appropriate quantities (e.g. "For 4 people, I'd suggest ordering 4 of our **[Item Name]** alongside 2 orders of **[Side Name]**"), and highlight why they go well together.
3. OFF-MENU REQUESTS:
   - If the customer asks for a dish, cuisine, or category that is NOT in the menu (for example, asking for curries, kebabs, or pizza when the restaurant only serves burgers), politely let them know that ${restaurantName} does not serve that item, and enthusiastically recommend the closest real options from our menu.
4. FORMATTING & ACTIONS:
   - Highlight dish names and deal names in **bold** (e.g. **Classic Cheeseburger**, **Family Feast Combo**) using the EXACT item names from the menu. Our interface will automatically attach one-tap interactive order cards for every bolded item.
   - You cannot charge cards or place the order yourself; guide the customer to tap the interactive card or button to add items to their cart.
   - Keep replies punchy, engaging, and easy to read on mobile.

AVAILABLE MENU CATEGORIES:
${categoriesText || '(see menu items below)'}

MENU:
${menuText || '(no items listed)'}

ACTIVE DEALS:
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
            const dynamicCards = extractDynamicCards(reply, items, deals);
            const dynamicBudget = extractDynamicBudget(lastUser, items);

            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  reply,
                  dealCards: dynamicCards.dealCards,
                  resolvedCards: dynamicCards.resolvedCards,
                  budgetCard: dynamicBudget,
                })}\n\n`,
              ),
            );
          } catch {
            // Dynamic fallback if models face temporary spikes
            const fallbackReply = streamedText.trim()
              ? streamedText.trim()
              : `I'd love to help you find something delicious at **${restaurantName}**! Take a look at our categories above, or let me know if you're in the mood for something savory, spicy, or sweet.`;
            const dynamicCards = extractDynamicCards(fallbackReply, items, deals);
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  reply: fallbackReply,
                  dealCards: dynamicCards.dealCards,
                  resolvedCards: dynamicCards.resolvedCards,
                  budgetCard: null,
                })}\n\n`,
              ),
            );
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

    // Non-streaming fallback
    let accumulated = '';
    try {
      const res = await raceGeminiStream(ORDER_AI_MODELS, systemPrompt, contents, (chunk) => {
        accumulated += chunk;
      });
      const reply = res.text.trim() || accumulated.trim() || 'What would you like to know about the menu?';
      const dynamicCards = extractDynamicCards(reply, items, deals);
      const dynamicBudget = extractDynamicBudget(lastUser, items);
      return NextResponse.json({
        reply,
        dealCards: dynamicCards.dealCards,
        resolvedCards: dynamicCards.resolvedCards,
        budgetCard: dynamicBudget,
      });
    } catch {
      return NextResponse.json({
        reply: `Browse the categories above — everything on the **${restaurantName}** menu is right there!`,
      });
    }
  } catch {
    return NextResponse.json({ reply: "Sorry, I couldn't process that — try browsing the menu above." });
  }
}
