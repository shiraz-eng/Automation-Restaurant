import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, aiEnabled, aiProvider } from '../env';
import { supabaseAdmin } from '../supabase';
import { requirePortalPerm } from '../middleware/portalAuth';
import { SAAS_AI_TOOLS, SAAS_SYSTEM_PROMPT, type SaasAiTool } from '../lib/saasAiTools';

/**
 * POST /api/saas-ai/chat — the billing/subscription assistant on the tenant
 * Billing page. Owner-only (same gate as Billing itself). Mirrors
 * customerAi.ts's dual-provider tool-calling loop, simplified for this
 * assistant's smaller, all-read tool set — see saasAiTools.ts for why this
 * can never reach operational or cross-tenant data.
 */
export const saasAiRouter = express.Router();

saasAiRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

const MAX_TURNS = 5;
type ChatMsg = { role: 'user' | 'assistant'; content: string };
const bodySchema = z.object({
  slug: z.string().min(1),
  restaurant_name: z.string().trim().max(120).optional(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }))
    .min(1)
    .max(20),
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

async function callTool(
  tool: SaasAiTool | undefined,
  input: Record<string, unknown>,
  admin: SupabaseClient,
  tenantId: string,
  trace: { name: string; ok: boolean }[],
  name: string,
): Promise<unknown> {
  if (!tool) {
    trace.push({ name, ok: false });
    return { error: 'tool_not_available' };
  }
  try {
    const out = await tool.run(admin, tenantId, input);
    trace.push({ name, ok: true });
    return out;
  } catch (err) {
    trace.push({ name, ok: false });
    return { error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

// ── Gemini (direct REST, matches routes/ai.ts / routes/customerAi.ts) ─────
type GPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: object } };
type GContent = { role: 'user' | 'model'; parts: GPart[] };

async function geminiGenerate(contents: GContent[], tools: SaasAiTool[], system: string) {
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

type ChatResult = { reply: string; trace: { name: string; ok: boolean }[] };

async function runGemini(messages: ChatMsg[], tools: SaasAiTool[], system: string, admin: SupabaseClient, tenantId: string): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: GContent[] = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const trace: ChatResult['trace'] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const content = await withRetry(() => geminiGenerate(contents, tools, system));
    const calls = content.parts.filter((p): p is Extract<GPart, { functionCall: unknown }> => 'functionCall' in p);
    if (calls.length === 0) {
      const text = content.parts.filter((p): p is { text: string } => 'text' in p).map((p) => p.text).join('\n').trim();
      return { reply: text || '(no answer)', trace };
    }
    contents.push(content);
    const parts: GPart[] = [];
    for (const c of calls) {
      const out = await callTool(byName.get(c.functionCall.name), (c.functionCall.args ?? {}) as Record<string, unknown>, admin, tenantId, trace, c.functionCall.name);
      const response = out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as object) : { result: out };
      parts.push({ functionResponse: { name: c.functionCall.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I ran out of steps before finishing — try asking again more specifically.', trace };
}

async function runAnthropic(messages: ChatMsg[], tools: SaasAiTool[], system: string, admin: SupabaseClient, tenantId: string): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: ChatResult['trace'] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: env.AI_MODEL,
      max_tokens: 500,
      system,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: convo,
    });
    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: text || '(no answer)', trace };
    }
    convo.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const out = await callTool(byName.get(block.name), (block.input ?? {}) as Record<string, unknown>, admin, tenantId, trace, block.name);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out).slice(0, 8000) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of steps before finishing — try asking again more specifically.', trace };
}

saasAiRouter.post('/chat', express.json({ limit: '50kb' }), requirePortalPerm('settings.view'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The billing assistant is not available right now.' });
  }
  if (req.tenant!.role !== 'owner') {
    return res.status(403).json({ error: 'owner_only', message: 'Only the restaurant owner can use the billing assistant.' });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { messages, restaurant_name } = parsed.data;

  const { data: t } = await supabaseAdmin.from('tenants').select('id').eq('slug', req.tenant!.slug).maybeSingle();
  if (!t) return res.status(404).json({ error: 'restaurant_not_found' });

  const system = SAAS_SYSTEM_PROMPT(restaurant_name || req.tenant!.slug);
  try {
    const result =
      aiProvider === 'gemini'
        ? await runGemini(messages, SAAS_AI_TOOLS, system, supabaseAdmin, t.id)
        : await runAnthropic(messages, SAAS_AI_TOOLS, system, supabaseAdmin, t.id);
    return res.json({ reply: result.reply, tools: result.trace, provider: aiProvider });
  } catch (err) {
    console.error('[saas-ai] chat failed:', err);
    return res.status(502).json({ error: 'ai_failed', message: 'The assistant could not complete that just now.' });
  }
});
