import { NextResponse } from 'next/server';
import { currencyInfo, formatMoney } from '@automation-restaurant/shared';

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
  title?: string;
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
 * Dynamically builds custom deal cards or budget cards:
 * - If the guest asks for a deal or meal for N people (e.g. "deal for 4 person", "meal for 2", "recommend for 4 people"),
 *   it constructs an interactive bundle card with an "Add all to cart" button.
 * - If the guest asks for an order under a budget (e.g. "under $50"), it builds a budget-fitting bundle.
 */
function extractDynamicDealOrBudget(
  lastUserMsg: string,
  reply: string,
  items: MenuContextItem[],
  deals: MenuContextDeal[],
): BudgetCard | null {
  const q = lastUserMsg.toLowerCase();

  // Detect group size (e.g. "deal for 4", "for 4 people", "4 persons", "meal for 2", "family of 5")
  const personMatch = q.match(/(?:for\s+)?(\d+|two|three|four|five|six|seven|eight)\s*(?:people|persons?|guests?|pax|of us)?/i);
  let personCount = 0;
  if (personMatch && personMatch[1]) {
    const raw = personMatch[1].toLowerCase();
    const wordMap: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
    personCount = wordMap[raw] || parseInt(raw, 10) || 0;
  }
  const isGroupQuery = personCount > 1 || q.includes('group') || q.includes('family') || q.includes('deal for') || q.includes('bundle');

  // Detect budget request
  const budgetMatch = q.match(/under\s+(?:rs\.?|pkr|\$|€|£)?\s*(\d+)/i) || q.match(/budget\s+(?:of\s+)?(?:rs\.?|pkr|\$|€|£)?\s*(\d+)/i);
  const budgetCents = budgetMatch && budgetMatch[1] ? parseInt(budgetMatch[1], 10) * 100 : 0;

  if (!isGroupQuery && budgetCents <= 0) return null;

  const count = personCount > 0 ? personCount : 4;

  // Extract items bolded in the AI's reply
  const boldMatches = Array.from(reply.matchAll(/\*\*([^*]+)\*\*/g)).map((m) => m[1]!.trim().toLowerCase());
  const recommendedItems = items.filter((it) => {
    const nameLower = it.name.toLowerCase();
    return boldMatches.some((b) => b === nameLower || b.includes(nameLower) || nameLower.includes(b));
  });

  // Check if an existing deal was recommended
  const recommendedDeal = deals.find((d) => {
    const nameLower = d.name.toLowerCase();
    return boldMatches.some((b) => b === nameLower || b.includes(nameLower) || nameLower.includes(b));
  });

  if (recommendedDeal) {
    const dealQty = Math.max(1, Math.floor(count / 2));
    return {
      title: `Recommended Deal for ${count} Persons`,
      items: [],
      deal: {
        deal_id: recommendedDeal.id || recommendedDeal.name,
        name: recommendedDeal.name,
        price_cents: recommendedDeal.price_cents,
        qty: dealQty,
      },
      subtotal_cents: recommendedDeal.price_cents * dealQty,
    };
  }

  // If specific items were bolded by the assistant for the custom deal
  if (recommendedItems.length > 0) {
    const picked: { variant_id: string; name: string; qty: number; unit_price_cents: number }[] = [];
    const mains = recommendedItems.filter((it) => {
      const cat = (it.category || '').toLowerCase();
      return !cat.includes('drink') && !cat.includes('beverage') && !cat.includes('side') && !cat.includes('dessert');
    });
    const sides = recommendedItems.filter((it) => {
      const cat = (it.category || '').toLowerCase();
      return cat.includes('side') || cat.includes('fry') || cat.includes('fries') || cat.includes('snack') || cat.includes('appetizer');
    });
    const drinks = recommendedItems.filter((it) => {
      const cat = (it.category || '').toLowerCase();
      return cat.includes('drink') || cat.includes('beverage') || cat.includes('shake') || cat.includes('soda');
    });

    if (mains.length > 0) {
      const qtyPerMain = Math.max(1, Math.round(count / mains.length));
      for (const m of mains) {
        picked.push({
          variant_id: m.id || m.name,
          name: m.name,
          qty: qtyPerMain,
          unit_price_cents: m.price_cents,
        });
      }
    } else {
      for (const it of recommendedItems.slice(0, 3)) {
        picked.push({
          variant_id: it.id || it.name,
          name: it.name,
          qty: Math.max(1, Math.round(count / Math.min(recommendedItems.length, 3))),
          unit_price_cents: it.price_cents,
        });
      }
    }

    for (const s of sides.slice(0, 2)) {
      picked.push({
        variant_id: s.id || s.name,
        name: s.name,
        qty: Math.max(1, Math.floor(count / 2)),
        unit_price_cents: s.price_cents,
      });
    }

    for (const d of drinks.slice(0, 1)) {
      picked.push({
        variant_id: d.id || d.name,
        name: d.name,
        qty: count,
        unit_price_cents: d.price_cents,
      });
    }

    if (picked.length > 0) {
      return {
        title: `Custom Deal for ${count} Persons`,
        items: picked,
        deal: null,
        subtotal_cents: picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0),
      };
    }
  }

  // If budget specified without group
  if (budgetCents > 0 && items.length > 0) {
    const affordable = items.filter((it) => it.price_cents <= budgetCents).sort((a, b) => b.price_cents - a.price_cents);
    const picked: { variant_id: string; name: string; qty: number; unit_price_cents: number }[] = [];
    let rem = budgetCents;
    for (const it of affordable) {
      if (it.price_cents <= rem) {
        picked.push({ variant_id: it.id || it.name, name: it.name, qty: 1, unit_price_cents: it.price_cents });
        rem -= it.price_cents;
        if (picked.length >= 3) break;
      }
    }
    if (picked.length > 0) {
      return {
        title: `Suggested Order Under ${(budgetCents / 100).toFixed(0)}`,
        items: picked,
        deal: null,
        subtotal_cents: picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0),
      };
    }
  }

  // Fallback: build bundle from popular/available items for group
  if (isGroupQuery && items.length > 0) {
    const mains = items.filter((it) => {
      const cat = (it.category || '').toLowerCase();
      return !cat.includes('drink') && !cat.includes('side') && !cat.includes('sauce');
    });
    const mainItem = mains[0] || items[0]!;
    const sides = items.filter((it) => (it.category || '').toLowerCase().includes('side'));
    const sideItem = sides[0];

    const picked = [
      {
        variant_id: mainItem.id || mainItem.name,
        name: mainItem.name,
        qty: count,
        unit_price_cents: mainItem.price_cents,
      },
    ];
    if (sideItem) {
      picked.push({
        variant_id: sideItem.id || sideItem.name,
        name: sideItem.name,
        qty: Math.max(1, Math.floor(count / 2)),
        unit_price_cents: sideItem.price_cents,
      });
    }

    return {
      title: `Custom Deal for ${count} Persons`,
      items: picked,
      deal: null,
      subtotal_cents: picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0),
    };
  }

  return null;
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
    // Display only (the guest's page sends the restaurant's currency); unknown codes fall back to USD.
    const currency = currencyInfo(typeof json.currency === 'string' ? json.currency : null);
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
      .map((i) => `- ${i.name}${i.category ? ` [Category: ${i.category}]` : ''}: ${formatMoney(i.price_cents, currency.code)}${i.description ? ` — ${i.description}` : ''}`)
      .join('\n');
    const dealsText = deals
      .map((d) => `- ${d.name}: ${formatMoney(d.price_cents, currency.code)}${d.description ? ` — ${d.description}` : ''}`)
      .join('\n');

    // Generic, dynamic ChatGPT-style concierge prompt with strict menu grounding, group deals, and health persuasion
    const systemPrompt = `You are the AI dining concierge and ordering assistant for ${restaurantName}, operating dynamically and conversationally just like ChatGPT.

Currency: prices are in ${currency.name} (${currency.code}). Always write prices like ${formatMoney(125050, currency.code)}, never "$" or another currency, and read a guest's budget in ${currency.code}.

Persona & Dynamic Style:
- Talk like ChatGPT: intelligent, warm, perceptive, witty when fitting, and completely natural. Never sound robotic, canned, or script-like.
- Adapt fluidly to the guest's language, tone, and vibe: English, Urdu, Roman Urdu ("kya hal hai", "bhai koi mast cheez batao"), Arabic, Spanish, French, casual banter, or formal dining inquiries.
- Give mouth-watering, descriptive details: explain flavor profiles (smoky, crispy, savory, creamy, tangy), textures, and aromas using the real items on our menu.
- Suggest delicious pairings dynamically (e.g. recommend a refreshing drink or side from our menu that complements their chosen main).

DEALS & GROUP RECOMMENDATIONS (FOR 1, 2, 4, OR ANY NUMBER OF PEOPLE):
- When a customer asks for a deal or recommendation for N people (e.g. "deal for 4 people", "create a deal for 4 person", "recommend for 4 people", "dinner for a family"):
  1. Check ACTIVE DEALS below: if there is an existing deal or combo that fits (or multiples of a combo), recommend that enthusiastically!
  2. If there is no pre-made deal for that exact group size, PROACTIVELY OFFER TO CREATE A CUSTOM DEAL for them!
     Propose a delicious, balanced bundle constructed from the MENU below:
     - Suggest N mains (or a mix of popular mains), appropriate sharing sides (e.g. 2 sides for 4 people), and drinks.
     - Bold every dish name in **bold** so interactive ordering buttons and a one-tap bundle card appear for the guest.
     - Invite them to customize or swap items if they prefer.

HEALTH & NUTRITIONAL PERSUASION (CONVINCE THE CUSTOMER WITH HEALTH BENEFITS):
- Actively highlight the nutritional and wellness benefits of dishes to convince and reassure the customer:
  - **Lean & High Protein**: Emphasize lean poultry, freshly grilled patties, or protein-rich options that promote sustained energy, satiety, and muscle recovery without sluggishness.
  - **Crisp Greens & Micronutrients**: Highlight fresh garden lettuce, ripe tomatoes, onions, and vegetables providing essential vitamins (Vitamin A, C), dietary fiber for gut health, and clean hydration.
  - **Fresh Preparation**: Highlight freshly grilled or made-to-order cooking that seals in natural juices without excessive grease.
  - **Nutritional Balance**: Explain how pairing protein with fiber and balanced carbs keeps blood sugar steady and provides enduring fuel for busy days or family dinners.
  - **Wholesome Dining**: When pitching a deal or meal for 4 people, explain how it provides a well-rounded, wholesome meal that satisfies everyone's appetite and energy needs.

CRITICAL ANTI-HALLUCINATION & MENU GROUNDING MANDATE (ZERO OFF-MENU ITEMS):
1. ONLY RECOMMEND WHAT IS ON THE MENU:
   - Your entire culinary world is STRICTLY CONFINED to the dishes listed under "MENU" and "ACTIVE DEALS" below.
   - You DO NOT have BBQ items, platters, curries, biryani, kebabs, tacos, pizza, sushi, or pasta UNLESS they appear word-for-word in the MENU below.
   - If an item or cuisine is not in the MENU text below, it DOES NOT EXIST at this restaurant.
   - Specifically, NEVER suggest generic items like "BBQ Tikka", "Seekh Kebabs", "Mutton Boti", "BBQ platters", "curries", "kebabs", "platters to share", "pasta", "pizza", or "tacos" UNLESS those exact items or categories are explicitly present in the MENU or ACTIVE DEALS below.
   - Even if the restaurant name includes words like "BBQ", "Grill", "Spice", or "Cafe", NEVER assume or invent dishes (like Seekh Kebabs or Mutton Boti) based on the name. Your ONLY source of food items is the MENU list below.
2. BEST SELLERS & POPULAR RECOMMENDATIONS:
   - When asked "What are your best sellers?" or for top recommendations, pick 2 to 4 real dishes from the MENU below, bolding their exact names in **bold** (e.g. **Classic Cheeseburger**).
   - NEVER say or guess what the kitchen is "famous for" if it is not in the MENU. Recommend real items from the MENU below with enthusiasm!
3. OFF-MENU REQUESTS:
   - If the customer asks for a dish, cuisine, or category that is NOT in the menu (for example, asking for BBQ, curries, kebabs, or pizza when the restaurant only serves burgers), politely state that ${restaurantName} does not serve that item, and enthusiastically recommend the closest real options from our menu.
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
            const dynamicBudget = extractDynamicDealOrBudget(lastUser, reply, items, deals);

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
            const dynamicBudget = extractDynamicDealOrBudget(lastUser, fallbackReply, items, deals);
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify({
                  reply: fallbackReply,
                  dealCards: dynamicCards.dealCards,
                  resolvedCards: dynamicCards.resolvedCards,
                  budgetCard: dynamicBudget,
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
      const dynamicBudget = extractDynamicDealOrBudget(lastUser, reply, items, deals);
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
