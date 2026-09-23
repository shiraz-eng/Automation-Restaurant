import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { env, aiEnabled, aiProvider } from '../env';
import { supabaseAdmin } from '../supabase';
import { requirePortalPerm } from '../middleware/portalAuth';
import {
  GUIDE_PUBLIC_TOOLS,
  ALL_GUIDE_TOOLS,
  GUIDE_SYSTEM_PROMPT,
  type GuideAiTool,
} from '../lib/guideAiTools';
import { createHash } from 'node:crypto';

/**
 * Automation Restaurant AI Guide — backend routes.
 *
 * Two chat endpoints:
 *   POST /api/public/guide-ai/chat   — unauthenticated, rate-limited (20 req/5 min per IP)
 *   POST /api/guide-ai/chat          — authenticated via requirePortalPerm('settings.view')
 *
 * One analytics endpoint (fire-and-forget, no auth):
 *   POST /api/public/guide-ai/event  — logs to guide_ai_events table
 *
 * Security model:
 *   - Public endpoint: NEVER has a tenantId; tools only read public plan/FAQ data.
 *   - Auth endpoint: tenantId is resolved from the verified portal session BEFORE
 *     any tool runs — never from request body.
 *   - Tools are architecturally isolated: they cannot reach other tenants' data.
 */

// ─── Rate limiter (simple in-memory, matches customerAi.ts pattern) ───────────

const rlMap = new Map<string, { count: number; reset: number }>();
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_LIMIT = 20;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rlMap.get(key);
  if (!entry || entry.reset < now) {
    rlMap.set(key, { count: 1, reset: now + RL_WINDOW_MS });
    return true;
  }
  if (entry.count >= RL_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── Shared constants ─────────────────────────────────────────────────────────

const MAX_TURNS = 5;
type ChatMsg = { role: 'user' | 'assistant'; content: string };

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(30),
  context: z
    .object({
      mode: z.enum(['public', 'portal']),
      page: z.string().max(500).optional(),
      slug: z.string().max(200).optional(),
    })
    .optional(),
});

const eventBodySchema = z.object({
  event: z.string().min(1).max(60),
  session_id: z.string().min(1).max(128),
  tenant_slug: z.string().max(200).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── Retry + tool executor ────────────────────────────────────────────────────

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

type ChatResult = { reply: string; actions?: unknown[]; trace: { name: string; ok: boolean }[] };

async function runTool(
  tool: GuideAiTool | undefined,
  name: string,
  input: Record<string, unknown>,
  tenantId: string,
  trace: ChatResult['trace'],
): Promise<unknown> {
  if (!tool) { trace.push({ name, ok: false }); return { error: 'tool_not_found' }; }
  try {
    const out = await tool.run(supabaseAdmin, tenantId, input);
    trace.push({ name, ok: true });
    return out;
  } catch (err) {
    trace.push({ name, ok: false });
    return { error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

// ─── Gemini agentic loop ──────────────────────────────────────────────────────

type GPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: object } };
type GContent = { role: 'user' | 'model'; parts: GPart[] };

async function geminiGenerate(contents: GContent[], tools: GuideAiTool[], system: string) {
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
  const json = (await res.json()) as {
    candidates?: { content?: GContent }[];
    error?: { code?: number; message?: string };
  };
  if (!res.ok || json.error) {
    const err = new Error(json.error?.message ?? `gemini ${res.status}`);
    (err as { status?: number }).status = json.error?.code ?? res.status;
    throw err;
  }
  return json.candidates?.[0]?.content ?? { role: 'model' as const, parts: [] };
}

async function runGemini(
  messages: ChatMsg[],
  tools: GuideAiTool[],
  system: string,
  tenantId: string,
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: GContent[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const trace: ChatResult['trace'] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const content = await withRetry(() => geminiGenerate(contents, tools, system));
    const calls = content.parts.filter(
      (p): p is Extract<GPart, { functionCall: unknown }> => 'functionCall' in p,
    );
    if (calls.length === 0) {
      const text = content.parts
        .filter((p): p is { text: string } => 'text' in p)
        .map((p) => p.text)
        .join('\n')
        .trim();
      return { reply: text || '(no answer)', trace };
    }
    contents.push(content);
    const parts: GPart[] = [];
    for (const c of calls) {
      const out = await runTool(
        byName.get(c.functionCall.name),
        c.functionCall.name,
        (c.functionCall.args ?? {}) as Record<string, unknown>,
        tenantId,
        trace,
      );
      const response =
        out !== null && typeof out === 'object' && !Array.isArray(out)
          ? (out as object)
          : { result: out };
      parts.push({ functionResponse: { name: c.functionCall.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I ran out of steps — please try asking more specifically.', trace };
}

// ─── Anthropic agentic loop ───────────────────────────────────────────────────

async function runAnthropic(
  messages: ChatMsg[],
  tools: GuideAiTool[],
  system: string,
  tenantId: string,
): Promise<ChatResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const trace: ChatResult['trace'] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await withRetry(() =>
      anthropic.messages.create({
        model: env.AI_MODEL,
        max_tokens: 800,
        system,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
        })),
        messages: convo,
      }),
    );
    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text || '(no answer)', trace };
    }
    convo.push({ role: 'assistant', content: resp.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const out = await runTool(
        byName.get(block.name),
        block.name,
        (block.input ?? {}) as Record<string, unknown>,
        tenantId,
        trace,
      );
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out).slice(0, 8000),
      });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of steps — please try asking more specifically.', trace };
}

// ─── CORS middleware (shared) ─────────────────────────────────────────────────

function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
}

async function runChat(
  messages: ChatMsg[],
  tools: GuideAiTool[],
  system: string,
  tenantId: string,
): Promise<ChatResult> {
  return aiProvider === 'gemini'
    ? runGemini(messages, tools, system, tenantId)
    : runAnthropic(messages, tools, system, tenantId);
}

// ─── Public router (mounted under /api/public) ────────────────────────────────

export const guideAiPublicRouter = express.Router();
guideAiPublicRouter.use(corsMiddleware);

guideAiPublicRouter.post(
  '/guide-ai/chat',
  express.json({ limit: '32kb' }),
  async (req: Request, res: Response) => {
    if (!aiEnabled) {
      return res.status(503).json({ error: 'ai_not_configured', message: 'The AI Guide is not available right now.' });
    }

    // Rate limit by IP.
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests — please wait a moment before asking again.' });
    }

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
    const { messages, context } = parsed.data;

    const system = GUIDE_SYSTEM_PROMPT('public');
    try {
      const result = await runChat(messages, GUIDE_PUBLIC_TOOLS, system, '');
      return res.json({ reply: result.reply, provider: aiProvider });
    } catch (err) {
      console.error('[guide-ai/public] chat failed:', err);
      return res.status(502).json({ error: 'ai_failed', message: 'The guide could not complete that just now.' });
    }
  },
);

guideAiPublicRouter.post(
  '/guide-ai/event',
  express.json({ limit: '8kb' }),
  async (req: Request, res: Response) => {
    const parsed = eventBodySchema.safeParse(req.body);
    if (!parsed.success) return res.sendStatus(204); // Silently ignore bad analytics

    const { event, session_id, tenant_slug, metadata } = parsed.data;
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';
    const ip_hash = ip ? createHash('sha256').update(ip).digest('hex') : null;

    // Fire-and-forget — never let analytics failure affect the response.
    Promise.resolve(
      supabaseAdmin
        .from('guide_ai_events')
        .insert({ session_id, tenant_slug: tenant_slug ?? null, event, metadata: metadata ?? {}, ip_hash }),
    ).catch((err: unknown) => console.warn('[guide-ai] analytics insert failed:', err));

    return res.sendStatus(204);
  },
);

// ─── Authenticated router (mounted under /api/guide-ai) ───────────────────────

export const guideAiAuthRouter = express.Router();
guideAiAuthRouter.use(corsMiddleware);

guideAiAuthRouter.post(
  '/chat',
  express.json({ limit: '32kb' }),
  requirePortalPerm('settings.view'),
  async (req: Request, res: Response) => {
    if (!aiEnabled) {
      return res.status(503).json({ error: 'ai_not_configured', message: 'The AI Guide is not available right now.' });
    }

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
    const { messages, context } = parsed.data;

    // Resolve tenantId from verified session — NEVER from request body.
    const { data: t } = await supabaseAdmin
      .from('tenants')
      .select('id, restaurant_name')
      .eq('slug', req.tenant!.slug)
      .maybeSingle();

    if (!t) return res.status(404).json({ error: 'restaurant_not_found' });

    const system = GUIDE_SYSTEM_PROMPT('authenticated', t.restaurant_name);
    try {
      const result = await runChat(messages, ALL_GUIDE_TOOLS, system, t.id);
      return res.json({ reply: result.reply, provider: aiProvider });
    } catch (err) {
      console.error('[guide-ai/auth] chat failed:', err);
      return res.status(502).json({ error: 'ai_failed', message: 'The guide could not complete that just now.' });
    }
  },
);
