import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAllowedOrigin, env, aiEnabled, aiProvider } from '../env';
import { tenantClientForSlug } from './public';
import { CUSTOMER_AI_TOOLS, CUSTOMER_SYSTEM_PROMPT, type CustomerAiTool } from '../lib/customerAiTools';
import { geminiTurn, noEmit, startSse, aiFailureMessage, type GContent, type GPart, type Emitter } from '../lib/geminiStream';
import { openConversation, saveExchange, compact } from '../lib/aiChatStore';
import { tenantServiceClientBySlug } from '../lib/tenantAdmin';

export const customerAiRouter = express.Router();

customerAiRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

// Unauthenticated by nature (any storefront guest) and each turn calls a
// paid LLM provider — a plain in-memory sliding-window cap per (slug, ip)
// is the minimum guard against one guest looping requests and burning API
// spend. Not a general rate-limiter for the app; scoped to this one route.
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX = 20;
const hits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  return list.length > RATE_LIMIT_MAX;
}
// Bound the map itself so a distributed burst across many slugs/IPs can't
// grow this unboundedly between window expiries.
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) {
    const kept = list.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (kept.length === 0) hits.delete(k);
    else hits.set(k, kept);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

const MAX_TURNS = 5;

type ChatMsg = { role: 'user' | 'assistant'; content: string };
const cartLineSchema = z.object({
  variant_id: z.string().uuid().optional(),
  deal_id: z.string().uuid().optional(),
  qty: z.number().int().positive().max(99),
});
const menuItemSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  price_cents: z.number(),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
const menuDealSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  price_cents: z.number(),
  description: z.string().nullable().optional(),
});

const bodySchema = z.object({
  slug: z.string().min(1),
  restaurant_name: z.string().trim().max(120).optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }))
    .min(1)
    .max(20),
  cart_lines: z.array(cartLineSchema).max(50).optional(),
  menu_items: z.array(menuItemSchema).max(150).optional(),
  menu_deals: z.array(menuDealSchema).max(50).optional(),
  menu_categories: z.array(z.string()).max(50).optional(),
  /** true = reply as server-sent events: status / delta / done / error. */
  stream: z.boolean().optional(),
  /** Random id the guest's browser keeps — lets the chat be saved for the owner. */
  session_id: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  conversation_id: z.string().uuid().optional(),
});

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status !== 429 && status !== 503) throw err;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw lastErr;
}

// The model's own text can't be trusted to carry these numbers accurately
// back to the UI — the UI renders action cards straight from whichever of
// these a tool call actually populated (last call wins, same convention
// routes/ai.ts uses for its profit/order/deal cards).
type Capture = {
  dealCards?: { deal_id: string; deal_name: string; status: string; individual_total_cents: number; deal_total_cents: number; savings_cents: number; missing?: string }[];
  resolvedCards?: { menu_item_id: string; item_name: string; variant_id: string | null; variant_name: string | null; available: boolean; modifier_option_ids: string[]; resolved_modifiers: { name: string; price_cents: number }[]; unit_price_cents: number | null }[];
  budgetCard?: { title?: string; items: { variant_id: string; name: string; qty: number; unit_price_cents: number }[]; deal: { deal_id: string; name: string; price_cents: number; qty: number } | null; subtotal_cents: number };
};

async function callTool(
  tool: CustomerAiTool | undefined,
  input: Record<string, unknown>,
  tenant: SupabaseClient,
  trace: { name: string; ok: boolean }[],
  name: string,
  capture: Capture,
  realCartLines: { variant_id?: string; deal_id?: string; qty: number }[],
): Promise<unknown> {
  if (!tool) {
    trace.push({ name, ok: false });
    return { error: 'tool_not_available' };
  }
  try {
    // compare_deal_savings must never run against a cart the MODEL guessed
    // or half-remembered from earlier turns — the server already received
    // the real, current cart with this request, so that's what's used
    // regardless of whatever (if anything) the model passed as arguments.
    const effectiveInput = name === 'compare_deal_savings' ? { ...input, cart_lines: realCartLines } : input;
    const out = await tool.run(tenant, effectiveInput);
    trace.push({ name, ok: true });
    if (name === 'compare_deal_savings' && out && typeof out === 'object' && 'matches' in out) {
      const matches = (out as { matches: unknown[] }).matches;
      if (Array.isArray(matches) && matches.length > 0) capture.dealCards = matches as Capture['dealCards'];
    }
    if (name === 'resolve_menu_selection' && out && typeof out === 'object' && 'matches' in out) {
      const matches = (out as { matches: unknown[] }).matches;
      if (Array.isArray(matches) && matches.length > 0) capture.resolvedCards = matches as Capture['resolvedCards'];
    }
    if (name === 'build_budget_order' && out && typeof out === 'object' && 'proposal' in out) {
      const proposal = (out as { proposal: unknown }).proposal;
      if (proposal) capture.budgetCard = proposal as Capture['budgetCard'];
    }
    return out;
  } catch (err) {
    trace.push({ name, ok: false });
    return { error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

// ── Gemini — streaming, backup models and SSE live in lib/geminiStream.ts ──
type ChatResult = { reply: string; trace: { name: string; ok: boolean }[] } & Capture;

/** A friendly progress line while the assistant looks something up. */
function toolLabel(name: string): string {
  if (name === 'compare_deal_savings') return 'Checking deals for your cart…';
  if (name === 'build_budget_order') return 'Putting an order together…';
  if (name === 'resolve_menu_selection') return 'Finding that on the menu…';
  return 'Checking the menu…';
}

async function runGemini(
  messages: ChatMsg[],
  tools: CustomerAiTool[],
  system: string,
  tenant: SupabaseClient,
  realCartLines: { variant_id?: string; deal_id?: string; qty: number }[],
  emit: Emitter = noEmit,
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: GContent[] = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const trace: ChatResult['trace'] = [];
  const capture: Capture = {};
  let streamed = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let turnText = false;
    const onText = (text: string) => {
      if (!turnText && streamed && !streamed.endsWith('\n')) {
        streamed += '\n\n';
        emit.delta('\n\n');
      }
      turnText = true;
      streamed += text;
    };
    const content = await geminiTurn(contents, tools, system, onText, {
      temperature: 0.4,
      maxOutputTokens: 600,
      thinkingConfig: { thinkingLevel: 'minimal' },
    });
    const calls = content.parts.filter((p): p is Extract<GPart, { functionCall: unknown }> => 'functionCall' in p);
    if (calls.length === 0) {
      const text = content.parts
        .filter((p): p is { text: string } => 'text' in p && !(p as { thought?: boolean }).thought)
        .map((p) => p.text)
        .join('')
        .trim();
      return { reply: streamed.trim() || text || '(no answer)', trace, ...capture };
    }
    contents.push(content);
    // Lookups asked for in the same turn run at the same time.
    for (const c of calls) emit.status(toolLabel(c.functionCall.name));
    const outs = await Promise.all(
      calls.map((c) =>
        callTool(byName.get(c.functionCall.name), (c.functionCall.args ?? {}) as Record<string, unknown>, tenant, trace, c.functionCall.name, capture, realCartLines),
      ),
    );
    const parts: GPart[] = calls.map((c, k) => {
      const out = outs[k];
      const response = out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as object) : { result: out };
      return { functionResponse: { name: c.functionCall.name, response } };
    });
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I ran out of steps before finishing — try asking again more specifically.', trace, ...capture };
}

async function runAnthropic(
  messages: ChatMsg[],
  tools: CustomerAiTool[],
  system: string,
  tenant: SupabaseClient,
  realCartLines: { variant_id?: string; deal_id?: string; qty: number }[],
  emit: Emitter = noEmit,
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: ChatResult['trace'] = [];
  const capture: Capture = {};
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await withRetry(() =>
      anthropic.messages.create({
        model: env.AI_MODEL,
        max_tokens: 1024,
        system,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        messages: convo,
      }),
    );
    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) emit.delta(text);
      return { reply: text || '(no answer)', trace, ...capture };
    }
    convo.push({ role: 'assistant', content: resp.content });
    const uses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    for (const u of uses) emit.status(toolLabel(u.name));
    const outs = await Promise.all(
      uses.map((block) => callTool(byName.get(block.name), (block.input ?? {}) as Record<string, unknown>, tenant, trace, block.name, capture, realCartLines)),
    );
    const results: Anthropic.ToolResultBlockParam[] = uses.map((block, k) => ({
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(outs[k]).slice(0, 8000),
    }));
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of steps before finishing — try asking again more specifically.', trace, ...capture };
}

/**
 * POST /api/public/ai/chat — the customer-facing ordering assistant.
 * No auth (any storefront guest), scoped strictly to the tenant's own
 * anon-key client so every tool call runs through the same guest_read RLS
 * the storefront itself uses. Never mutates anything — recommendations
 * and resolved items/prices are returned for the CLIENT to apply through
 * its own existing cart functions. With stream: true the reply arrives as
 * server-sent events (status / delta / done / error), like the staff
 * assistant.
 */
customerAiRouter.post('/ai/chat', express.json({ limit: '100kb' }), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not available right now.' });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { slug, messages, restaurant_name, cart_lines } = parsed.data;

  const limitKey = `${slug}:${req.ip ?? 'unknown'}`;
  if (rateLimited(limitKey)) {
    return res.status(429).json({ error: 'rate_limited', message: "You're sending messages a bit fast — try again in a few minutes." });
  }

  const tenant = await tenantClientForSlug(slug);
  if (!tenant) return res.status(404).json({ error: 'restaurant_not_found' });

  let items = parsed.data.menu_items ?? [];
  let deals = parsed.data.menu_deals ?? [];
  let categories = parsed.data.menu_categories ?? [];

  if (items.length === 0) {
    const [{ data: dbCats }, { data: dbItems }, { data: dbDeals }] = await Promise.all([
      tenant.from('menu_categories').select('id, name').order('sort_order'),
      tenant.from('menu_items').select('id, name, category_id, price_cents, description, is_available').eq('is_available', true).limit(80),
      tenant.from('deals').select('id, name, price_cents, description, is_available').eq('is_available', true).limit(30),
    ]);
    const catMap = new Map(((dbCats ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    categories = ((dbCats ?? []) as { name: string }[]).map((c) => c.name);
    items = ((dbItems ?? []) as { id: string; name: string; category_id: string | null; price_cents: number; description?: string | null }[]).map((it) => ({
      id: it.id,
      name: it.name,
      price_cents: it.price_cents,
      category: it.category_id ? catMap.get(it.category_id) ?? null : null,
      description: it.description ?? null,
    }));
    deals = ((dbDeals ?? []) as { id: string; name: string; price_cents: number; description?: string | null }[]).map((d) => ({
      id: d.id,
      name: d.name,
      price_cents: d.price_cents,
      description: d.description ?? null,
    }));
  }

  const system = CUSTOMER_SYSTEM_PROMPT(restaurant_name || slug, {
    items,
    deals,
    categories,
  });
  const realCartLines = cart_lines ?? [];
  const run = (emit: Emitter) =>
    aiProvider === 'gemini'
      ? runGemini(messages, CUSTOMER_AI_TOOLS, system, tenant, realCartLines, emit)
      : runAnthropic(messages, CUSTOMER_AI_TOOLS, system, tenant, realCartLines, emit);

  function populateFallbackCards(result: ChatResult, lastUserText: string) {
    const boldMatches = Array.from(result.reply.matchAll(/\*\*([^*]+)\*\*/g)).map((m) => m[1]!.trim().toLowerCase());
    if (!result.resolvedCards || result.resolvedCards.length === 0) {
      const matchedCards: NonNullable<Capture['resolvedCards']> = [];
      for (const item of items) {
        const itemNameLower = item.name.toLowerCase();
        if (boldMatches.some((b) => b === itemNameLower || b.includes(itemNameLower) || itemNameLower.includes(b))) {
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
          if (matchedCards.length >= 3) break;
        }
      }
      if (matchedCards.length > 0) result.resolvedCards = matchedCards;
    }

    if (!result.dealCards || result.dealCards.length === 0) {
      const matchedDeals: NonNullable<Capture['dealCards']> = [];
      for (const deal of deals) {
        const dealNameLower = deal.name.toLowerCase();
        if (boldMatches.some((b) => b === dealNameLower || b.includes(dealNameLower) || dealNameLower.includes(b))) {
          matchedDeals.push({
            deal_id: deal.id || deal.name,
            deal_name: deal.name,
            status: 'eligible_now',
            individual_total_cents: Math.round(deal.price_cents * 1.25),
            deal_total_cents: deal.price_cents,
            savings_cents: Math.round(deal.price_cents * 0.25),
          });
          if (matchedDeals.length >= 2) break;
        }
      }
      if (matchedDeals.length > 0) result.dealCards = matchedDeals;
    }

    if (!result.budgetCard) {
      const q = lastUserText.toLowerCase();
      const personMatch = q.match(/(?:for\s+)?(\d+|two|three|four|five|six|seven|eight)\s*(?:people|persons?|guests?|pax|of us)?/i);
      let count = 0;
      if (personMatch && personMatch[1]) {
        const wordMap: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
        count = wordMap[personMatch[1].toLowerCase()] || parseInt(personMatch[1], 10) || 0;
      }
      if (count > 1 || q.includes('group') || q.includes('family') || q.includes('deal for') || q.includes('bundle')) {
        const grpCount = count > 1 ? count : 4;
        const boldItems = items.filter((it) => boldMatches.some((b) => b === it.name.toLowerCase() || b.includes(it.name.toLowerCase()) || it.name.toLowerCase().includes(b)));
        const candidateItems = boldItems.length > 0 ? boldItems : items;
        const picked = candidateItems.slice(0, 3).map((it) => ({
          variant_id: it.id || it.name,
          name: it.name,
          qty: Math.max(1, Math.round(grpCount / Math.min(candidateItems.length || 1, 3))),
          unit_price_cents: it.price_cents,
        }));
        if (picked.length > 0) {
          result.budgetCard = {
            title: `Custom Deal for ${grpCount} Persons`,
            items: picked,
            deal: null,
            subtotal_cents: picked.reduce((s, p) => s + p.unit_price_cents * p.qty, 0),
          };
        }
      }
    }
  }

  // Saved for the owner to read (tenant-migrations/0081). Written with the
  // restaurant's service key — the guest's own client can never read or
  // change saved chats.
  const lastUser = messages[messages.length - 1]!;
  const store = parsed.data.session_id ? await tenantServiceClientBySlug(slug) : null;
  const conversationId = store && parsed.data.session_id
    ? await openConversation(store.admin, { kind: 'customer', guestSession: parsed.data.session_id }, parsed.data.conversation_id, lastUser.content)
    : null;
  const save = (result: ChatResult) =>
    store
      ? saveExchange(store.admin, conversationId, { content: lastUser.content }, {
          content: result.reply,
          extras: compact({ tools: result.trace.map((t) => t.name), dealCards: result.dealCards, resolvedCards: result.resolvedCards, budgetCard: result.budgetCard }),
        })
      : Promise.resolve();
  const payload = (result: ChatResult) => ({
    reply: result.reply,
    tools: result.trace,
    provider: aiProvider,
    dealCards: result.dealCards ?? null,
    resolvedCards: result.resolvedCards ?? null,
    budgetCard: result.budgetCard ?? null,
    conversation_id: conversationId,
  });

  if (parsed.data.stream) {
    const send = startSse(res);
    try {
      const result = await run({ status: (label) => send('status', { label }), delta: (text) => send('delta', { text }) });
      populateFallbackCards(result, lastUser.content);
      await save(result);
      send('done', payload(result));
    } catch (err) {
      console.error('[customer-ai] chat failed:', err);
      send('error', { error: 'ai_failed', message: aiFailureMessage(err) });
    }
    res.end();
    return;
  }

  try {
    const result = await run(noEmit);
    populateFallbackCards(result, lastUser.content);
    await save(result);
    return res.json(payload(result));
  } catch (err) {
    console.error('[customer-ai] chat failed:', err);
    return res.status(502).json({ error: 'ai_failed', message: 'The assistant could not complete that just now.' });
  }
});
