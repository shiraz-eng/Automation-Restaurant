import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, aiEnabled, aiProvider } from '../env';
import { tenantClientForSlug } from './public';
import { CUSTOMER_AI_TOOLS, CUSTOMER_SYSTEM_PROMPT, type CustomerAiTool } from '../lib/customerAiTools';

export const customerAiRouter = express.Router();

customerAiRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
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
const bodySchema = z.object({
  slug: z.string().min(1),
  restaurant_name: z.string().trim().max(120).optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }))
    .min(1)
    .max(20),
  cart_lines: z.array(cartLineSchema).max(50).optional(),
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
  budgetCard?: { items: { variant_id: string; name: string; qty: number; unit_price_cents: number }[]; deal: { deal_id: string; name: string; price_cents: number; qty: number } | null; subtotal_cents: number };
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

// ── Gemini (direct REST, matches routes/ai.ts's own pattern) ──────────────
type GPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: object } };
type GContent = { role: 'user' | 'model'; parts: GPart[] };

async function geminiGenerate(contents: GContent[], tools: CustomerAiTool[], system: string) {
  const decls = tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.input_schema.properties).length ? { parameters: t.input_schema } : {}),
  }));
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': env.GEMINI_API_KEY as string },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as { candidates?: { content?: GContent }[]; error?: { code?: number; message?: string } };
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message ?? `gemini ${res.status}`);
    (err as { status?: number }).status = json.error?.code ?? res.status;
    throw err;
  }
  return json.candidates?.[0]?.content ?? { role: 'model' as const, parts: [] };
}

type ChatResult = { reply: string; trace: { name: string; ok: boolean }[] } & Capture;

async function runGemini(
  messages: ChatMsg[],
  tools: CustomerAiTool[],
  system: string,
  tenant: SupabaseClient,
  realCartLines: { variant_id?: string; deal_id?: string; qty: number }[],
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: GContent[] = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const trace: ChatResult['trace'] = [];
  const capture: Capture = {};
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const content = await withRetry(() => geminiGenerate(contents, tools, system));
    const calls = content.parts.filter((p): p is Extract<GPart, { functionCall: unknown }> => 'functionCall' in p);
    if (calls.length === 0) {
      const text = content.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join('\n').trim();
      return { reply: text || '(no answer)', trace, ...capture };
    }
    contents.push(content);
    const parts: GPart[] = [];
    for (const c of calls) {
      const out = await callTool(byName.get(c.functionCall.name), (c.functionCall.args ?? {}) as Record<string, unknown>, tenant, trace, c.functionCall.name, capture, realCartLines);
      const response = out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as object) : { result: out };
      parts.push({ functionResponse: { name: c.functionCall.name, response } });
    }
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
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: ChatResult['trace'] = [];
  const capture: Capture = {};
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: env.AI_MODEL,
      max_tokens: 700,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: convo,
    });
    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text || '(no answer)', trace, ...capture };
    }
    convo.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const out = await callTool(byName.get(block.name), (block.input ?? {}) as Record<string, unknown>, tenant, trace, block.name, capture, realCartLines);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 8000) });
    }
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
 * its own existing cart functions.
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

  const system = CUSTOMER_SYSTEM_PROMPT(restaurant_name || slug);
  try {
    const realCartLines = cart_lines ?? [];
    const result =
      aiProvider === 'gemini'
        ? await runGemini(messages, CUSTOMER_AI_TOOLS, system, tenant, realCartLines)
        : await runAnthropic(messages, CUSTOMER_AI_TOOLS, system, tenant, realCartLines);
    return res.json({
      reply: result.reply,
      tools: result.trace,
      provider: aiProvider,
      dealCards: result.dealCards ?? null,
      resolvedCards: result.resolvedCards ?? null,
      budgetCard: result.budgetCard ?? null,
    });
  } catch (err) {
    console.error('[customer-ai] chat failed:', err);
    return res.status(502).json({ error: 'ai_failed', message: 'The assistant could not complete that just now.' });
  }
});
