import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, aiEnabled, aiProvider } from '../env';
import { requirePortalPerm, permits } from '../middleware/portalAuth';
import { AI_TOOLS, SYSTEM_PROMPT, type AiTool } from '../lib/aiTools';

export const aiRouter = express.Router();

aiRouter.use((req: Request, res: Response, next: NextFunction) => {
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

const bodySchema = z.object({
  slug: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }))
    .min(1)
    .max(30),
});
type ChatMsg = z.infer<typeof bodySchema>['messages'][number];

const MAX_TURNS = 6;
type AgentResult = { reply: string; trace: { name: string; ok: boolean }[] };

/** Retry a call through transient 429/503 "high demand" from the model host. */
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
  tool: AiTool | undefined,
  input: Record<string, unknown>,
  admin: SupabaseClient,
  userId: string,
  trace: { name: string; ok: boolean }[],
  name: string,
): Promise<unknown> {
  if (!tool) {
    trace.push({ name, ok: false });
    return { error: 'tool_not_available' };
  }
  try {
    const out = await tool.run(admin, input);
    trace.push({ name, ok: true });
    await admin
      .from('audit_logs')
      .insert({ actor_id: userId, action: 'ai.tool', entity: name, after: { input } });
    return out;
  } catch (err) {
    trace.push({ name, ok: false });
    return { error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

// ── Gemini (direct REST — the SDK's role/shape assumptions vary by endpoint) ─
type GPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: object } };
type GContent = { role: 'user' | 'model'; parts: GPart[] };

async function geminiGenerate(contents: GContent[], tools: AiTool[], system: string) {
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
  tools: AiTool[],
  system: string,
  admin: SupabaseClient,
  userId: string,
): Promise<AgentResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: GContent[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const trace: AgentResult['trace'] = [];

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
      const out = await callTool(
        byName.get(c.functionCall.name),
        (c.functionCall.args ?? {}) as Record<string, unknown>,
        admin,
        userId,
        trace,
        c.functionCall.name,
      );
      const response =
        out !== null && typeof out === 'object' && !Array.isArray(out)
          ? (out as object)
          : { result: out };
      parts.push({ functionResponse: { name: c.functionCall.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I ran out of steps before finishing — try a narrower question.', trace };
}

// ── Anthropic ─────────────────────────────────────────────────────────────
async function runAnthropic(
  messages: ChatMsg[],
  tools: AiTool[],
  system: string,
  admin: SupabaseClient,
  userId: string,
): Promise<AgentResult> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: AgentResult['trace'] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: env.AI_MODEL,
      max_tokens: 1024,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages: convo,
    });
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
      const out = await callTool(
        byName.get(block.name),
        (block.input ?? {}) as Record<string, unknown>,
        admin,
        userId,
        trace,
        block.name,
      );
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out).slice(0, 12000),
      });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of steps before finishing — try a narrower question.', trace };
}

/**
 * POST /api/ai/chat — the AI operations assistant. The caller's permissions
 * decide which tools the model is offered; every tool is read-only and its
 * result is fetched only after a per-tool permission check. The model never
 * sees the database, credentials, or arbitrary SQL.
 */
aiRouter.post(
  '/chat',
  express.json(),
  requirePortalPerm('ai.view'),
  async (req: Request, res: Response) => {
    if (!aiEnabled) {
      return res
        .status(503)
        .json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });

    const { admin, permissions, role, userId } = req.tenant!;
    if (!permits(permissions, role, 'ai.execute_read')) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not allowed to run AI queries.' });
    }

    const allowed = AI_TOOLS.filter((t) => permits(permissions, role, t.needs));
    const system = SYSTEM_PROMPT(req.tenant!.slug);

    try {
      const result =
        aiProvider === 'gemini'
          ? await runGemini(parsed.data.messages, allowed, system, admin, userId)
          : await runAnthropic(parsed.data.messages, allowed, system, admin, userId);
      return res.json({ reply: result.reply, tools: result.trace, provider: aiProvider });
    } catch (err) {
      console.error('[ai] chat failed:', err);
      return res.status(502).json({ error: 'ai_failed', message: 'The assistant could not complete the request.' });
    }
  },
);
