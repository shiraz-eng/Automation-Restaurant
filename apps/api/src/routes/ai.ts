import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env, aiEnabled, aiProvider } from '../env';
import { requirePortalPerm, permits } from '../middleware/portalAuth';
import { AI_TOOLS, AI_ACTIONS, SYSTEM_PROMPT, computeAttentionItems, periodRange, resolvePeriod, type AiTool, type AiAction, type Period } from '../lib/aiTools';
import { buildExcelWorkbook } from '../lib/excelExport';

/**
 * Export audit trail (spec §39) — one row per generated report/export,
 * written right after it actually succeeds or fails. Best-effort and
 * non-fatal by design: export_audit_log is a NEW table (tenant-migrations/
 * 0037) that an existing tenant's database won't have until that migration
 * is applied, and a missing audit table must never break the export itself
 * — the report/workbook has already been built and handed back by the time
 * this runs, so a logging failure here is swallowed, not surfaced.
 */
async function logExportAudit(
  admin: SupabaseClient,
  entry: {
    format: 'pdf' | 'excel';
    periodLabel: string;
    from: Date;
    to: Date;
    sheets?: string[];
    userId?: string | null;
    email?: string | null;
    role?: string | null;
    status: 'ready' | 'failed';
    error?: string;
  },
) {
  try {
    await admin.from('export_audit_log').insert({
      format: entry.format,
      period_label: entry.periodLabel,
      period_from: entry.from.toISOString(),
      period_to: entry.to.toISOString(),
      sheets: entry.sheets && entry.sheets.length > 0 ? entry.sheets : null,
      requested_by: entry.userId ?? null,
      requested_by_email: entry.email ?? null,
      requested_by_role: entry.role ?? null,
      status: entry.status,
      error: entry.error ?? null,
    });
  } catch (err) {
    console.warn('[ai] export audit log write skipped (export_audit_log likely not migrated yet):', err);
  }
}

/** Anything the model can be offered as a callable function — a read tool or a proposable action. */
type ToolLike = { name: string; description: string; input_schema: AiTool['input_schema'] };

/** The model is never told "today" by its training — without this it has no
 *  way to resolve "tonight" / "tomorrow" / "this Friday" into a real date
 *  (matters for create_reservation and anything else date-relative). Reads
 *  the restaurant's own configured timezone (business_settings), the same
 *  one promotion scheduling and reporting already reason in, rather than
 *  assuming server-local or UTC. */
async function currentTimeLine(admin: SupabaseClient): Promise<string> {
  const { data } = await admin.from('business_settings').select('timezone').eq('id', true).maybeSingle();
  const tz = data?.timezone || 'UTC';
  const now = new Date();
  let formatted: string;
  try {
    formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(now);
  } catch {
    formatted = now.toISOString();
  }
  return `Current date/time at this restaurant: ${formatted} (${tz}). Resolve "tonight" / "tomorrow" / "this Friday" etc. against this, never against your own training cutoff.`;
}

export const aiRouter = express.Router();

aiRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

/**
 * GET /api/ai/attention — the Exception Center (spec §11): the SAME
 * computeAttentionItems() the AI's get_attention_items tool and morning
 * get_daily_brief already use, exposed as a plain endpoint so the portal
 * can show it as a real page a manager can glance at without opening chat.
 * One authoritative computation, two consumption points — never a second,
 * UI-side reimplementation of the same exception logic (spec §54).
 */
/** The exact same "category::message" the exception itself carries is its
 *  fingerprint — no separate ID scheme to keep in sync, and the moment the
 *  condition changes even slightly, that's honestly a different exception
 *  and correctly starts unacknowledged. */
function exceptionFingerprint(item: { category: string; message: string }): string {
  return `${item.category}::${item.message}`;
}

aiRouter.get('/attention', requirePortalPerm('orders.view'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  try {
    const items = await computeAttentionItems(admin);
    const fingerprints = items.map(exceptionFingerprint);
    const { data: states } =
      fingerprints.length > 0
        ? await admin.from('exception_states').select('fingerprint, status, note, actor_email, updated_at').in('fingerprint', fingerprints)
        : { data: [] };
    const byFingerprint = new Map((states ?? []).map((s) => [s.fingerprint, s]));
    const withState = items.map((item) => ({ ...item, state: byFingerprint.get(exceptionFingerprint(item)) ?? null }));
    res.json({ items: withState });
  } catch (err) {
    console.error('[ai] attention fetch failed:', err);
    res.status(500).json({ error: 'attention_fetch_failed' });
  }
});

const attentionStateSchema = z.object({
  slug: z.string().min(1),
  category: z.string().min(1),
  message: z.string().min(1),
  status: z.enum(['acknowledged', 'resolved', 'ignored']),
  note: z.string().max(500).optional(),
});

/**
 * POST /api/ai/attention/state — records a manager's decision on one
 * exception (spec §11: ACKNOWLEDGE / RESOLVE / IGNORE). Gated the same as
 * viewing the Exception Center itself (orders.view) — this only records
 * that a human looked at it, it doesn't mutate the underlying condition,
 * so it doesn't need a stricter bar than seeing the exception in the
 * first place.
 */
aiRouter.post('/attention/state', express.json(), requirePortalPerm('orders.view'), async (req: Request, res: Response) => {
  const parsed = attentionStateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const fingerprint = exceptionFingerprint({ category: parsed.data.category, message: parsed.data.message });
  const { error } = await admin.from('exception_states').upsert({
    fingerprint,
    status: parsed.data.status,
    note: parsed.data.note ?? null,
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    updated_at: new Date().toISOString(),
  });
  if (error) return res.status(500).json({ error: 'state_update_failed', message: error.message });
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: `exception.${parsed.data.status}`,
    entity: 'exception_states',
    entity_id: fingerprint,
    after: { category: parsed.data.category, message: parsed.data.message, note: parsed.data.note ?? null },
  });
  return res.json({ ok: true });
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
type PendingAction = { id: string; name: string; args: Record<string, unknown>; summary: string };
// The exact period_profitability() row plus the resolved date range and
// label — captured verbatim from get_period_profitability's own tool
// result (never recomputed) so the chat UI can render a real, clickable
// drill-down card tied to precisely the figures the model just talked
// about, using the SAME ProfitDrilldownModal the Dashboard/Finance pages
// already use, without a second fetch that could drift from what was said.
type ProfitCard = {
  period: string;
  from_ts: string;
  to_ts: string;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};
// get_order_profitability's own result (order_profitability() row + its
// order_lines, spec §10) captured the same way — one order's real bridge
// and its actual items, never recomputed for the card.
type OrderCard = {
  order_id: string;
  order_number: number;
  status: string;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  cogs_cents: number;
  cogs_lines_missing: number;
  food_cost_pct: number | null;
  contribution_cents: number;
  contribution_margin_pct: number | null;
  lines: { name_snapshot: string; qty: number; line_total_cents: number; recipe_cost_cents: number | null; menu_item_id: string | null; variant_id: string | null; deal_id: string | null }[];
};
// get_deal_profitability's own result (deal_profitability() rows for a
// period, spec §11) — the whole ranked list, captured verbatim.
type DealCard = {
  period: string;
  deals: {
    deal_id: string;
    name: string;
    qty_sold: number;
    revenue_cents: number;
    cogs_cents: number;
    cogs_known: boolean;
    contribution_cents: number;
    contribution_margin_pct: number | null;
    food_cost_pct: number | null;
    list_value_cents: number | null;
    customer_saving_cents: number | null;
  }[];
};
type AgentResult = {
  reply: string;
  trace: { name: string; ok: boolean }[];
  pendingAction?: PendingAction;
  profitCard?: ProfitCard;
  orderCard?: OrderCard;
  dealCard?: DealCard;
};
/** Who is chatting — threaded through to proposeAction() so a persisted
 *  ai_pending_actions row (the Approval Inbox, spec §29) always knows who
 *  proposed it, not just who eventually confirmed it. */
type Actor = { userId: string; email: string | null; role: string | null };

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
  capture: { profitCard?: ProfitCard; orderCard?: OrderCard; dealCard?: DealCard },
): Promise<unknown> {
  if (!tool) {
    trace.push({ name, ok: false });
    return { error: 'tool_not_available' };
  }
  try {
    const out = await tool.run(admin, input);
    trace.push({ name, ok: true });
    // Last one wins if the model calls the same tool more than once in a
    // turn (e.g. comparing two periods, or two orders) — the card always
    // matches the LATEST one it actually reported on in its final reply.
    if (name === 'get_period_profitability' && out && typeof out === 'object' && 'net_profit_cents' in out) {
      capture.profitCard = out as ProfitCard;
    }
    if (name === 'get_order_profitability' && out && typeof out === 'object' && 'contribution_cents' in out) {
      capture.orderCard = out as OrderCard;
    }
    if (name === 'get_deal_profitability' && out && typeof out === 'object' && 'deals' in out && Array.isArray((out as { deals: unknown }).deals) && (out as { deals: unknown[] }).deals.length > 0) {
      capture.dealCard = out as DealCard;
    }
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

async function geminiGenerate(contents: GContent[], tools: ToolLike[], system: string) {
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
  actions: AiAction[],
  system: string,
  admin: SupabaseClient,
  actor: Actor,
): Promise<AgentResult> {
  const userId = actor.userId;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const actionByName = new Map(actions.map((a) => [a.name, a]));
  const declared: ToolLike[] = [...tools, ...actions];
  const contents: GContent[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const trace: AgentResult['trace'] = [];
  const capture: { profitCard?: ProfitCard; orderCard?: OrderCard; dealCard?: DealCard } = {};

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const content = await withRetry(() => geminiGenerate(contents, declared, system));
    const calls = content.parts.filter(
      (p): p is Extract<GPart, { functionCall: unknown }> => 'functionCall' in p,
    );
    if (calls.length === 0) {
      const text = content.parts
        .filter((p): p is { text: string } => 'text' in p)
        .map((p) => p.text)
        .join('\n')
        .trim();
      return { reply: text || '(no answer)', trace, profitCard: capture.profitCard, orderCard: capture.orderCard, dealCard: capture.dealCard };
    }

    const leadText = content.parts
      .filter((p): p is { text: string } => 'text' in p)
      .map((p) => p.text)
      .join('\n')
      .trim();
    const actionCall = calls.find((c) => actionByName.has(c.functionCall.name));
    if (actionCall) {
      const pending = await proposeAction(
        actionByName.get(actionCall.functionCall.name)!,
        (actionCall.functionCall.args ?? {}) as Record<string, unknown>,
        admin,
        leadText,
        trace,
        actor,
      );
      return pending;
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
        capture,
      );
      const response =
        out !== null && typeof out === 'object' && !Array.isArray(out)
          ? (out as object)
          : { result: out };
      parts.push({ functionResponse: { name: c.functionCall.name, response } });
    }
    contents.push({ role: 'user', parts });
  }
  return { reply: 'I ran out of steps before finishing — try a narrower question.', trace, profitCard: capture.profitCard, orderCard: capture.orderCard, dealCard: capture.dealCard };
}

/**
 * Called instead of executing an action tool. Builds a plain-language summary
 * of exactly what would change (never runs the mutation) and returns it as a
 * proposal for the human to confirm via POST /api/ai/confirm. If the target
 * is already invalid (deleted, already in that state), reports that instead
 * of proposing anything.
 */
async function proposeAction(
  action: AiAction,
  args: Record<string, unknown>,
  admin: SupabaseClient,
  leadText: string,
  trace: AgentResult['trace'],
  actor: Actor,
): Promise<AgentResult> {
  const described = await action.describe(admin, args);
  if (!described.ok) {
    trace.push({ name: action.name, ok: false });
    return { reply: leadText || described.error, trace };
  }
  trace.push({ name: action.name, ok: true });
  // Persisted immediately (spec §29 — Approval Inbox): a proposal must be
  // visible to any authorized approver, not just retrievable from this one
  // chat's own React state until someone happens to click Confirm here.
  const { data: row, error: insErr } = await admin
    .from('ai_pending_actions')
    .insert({
      action_name: action.name,
      args,
      summary: described.summary,
      proposed_by: actor.userId,
      proposed_by_email: actor.email,
      proposed_by_role: actor.role,
    })
    .select('id')
    .single();
  if (insErr || !row) {
    console.error('[ai] failed to persist pending action:', insErr);
    // Degrade gracefully — the inline chat confirm/cancel still works from
    // React state even if the Inbox never sees this one; never block the
    // proposal itself over a logging-adjacent write failing.
    return {
      reply: leadText || 'Here is what I would do — confirm below to go ahead.',
      trace,
      pendingAction: { id: '', name: action.name, args, summary: described.summary },
    };
  }
  return {
    reply: leadText || 'Here is what I would do — confirm below to go ahead.',
    trace,
    pendingAction: { id: row.id, name: action.name, args, summary: described.summary },
  };
}

// ── Anthropic ─────────────────────────────────────────────────────────────
async function runAnthropic(
  messages: ChatMsg[],
  tools: AiTool[],
  actions: AiAction[],
  system: string,
  admin: SupabaseClient,
  actor: Actor,
): Promise<AgentResult> {
  const userId = actor.userId;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const actionByName = new Map(actions.map((a) => [a.name, a]));
  const declared: ToolLike[] = [...tools, ...actions];
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const convo: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }));
  const trace: AgentResult['trace'] = [];
  const capture: { profitCard?: ProfitCard; orderCard?: OrderCard; dealCard?: DealCard } = {};

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await anthropic.messages.create({
      model: env.AI_MODEL,
      max_tokens: 1024,
      system,
      tools: declared.map((t) => ({
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
      return { reply: text || '(no answer)', trace, profitCard: capture.profitCard, orderCard: capture.orderCard, dealCard: capture.dealCard };
    }

    const leadText = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    const actionBlock = resp.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && actionByName.has(b.name),
    );
    if (actionBlock) {
      return proposeAction(
        actionByName.get(actionBlock.name)!,
        (actionBlock.input ?? {}) as Record<string, unknown>,
        admin,
        leadText,
        trace,
        actor,
      );
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
        capture,
      );
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(out).slice(0, 12000),
      });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'I ran out of steps before finishing — try a narrower question.', trace, profitCard: capture.profitCard, orderCard: capture.orderCard, dealCard: capture.dealCard };
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

    const { admin, permissions, role, userId, email } = req.tenant!;
    if (!permits(permissions, role, 'ai.execute_read')) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not allowed to run AI queries.' });
    }

    const allowedTools = AI_TOOLS.filter((t) => permits(permissions, role, t.needs));
    // An action is only offered to the model when the caller holds BOTH the
    // AI-specific write gate and the underlying business permission it acts on.
    const allowedActions = permits(permissions, role, 'ai.execute_write')
      ? AI_ACTIONS.filter((a) => permits(permissions, role, a.needs))
      : [];
    const system = SYSTEM_PROMPT(req.tenant!.slug, await currentTimeLine(admin));
    const actor: Actor = { userId, email, role };

    try {
      const result =
        aiProvider === 'gemini'
          ? await runGemini(parsed.data.messages, allowedTools, allowedActions, system, admin, actor)
          : await runAnthropic(parsed.data.messages, allowedTools, allowedActions, system, admin, actor);
      return res.json({
        reply: result.reply,
        tools: result.trace,
        provider: aiProvider,
        pendingAction: result.pendingAction ?? null,
        profitCard: result.profitCard ?? null,
        orderCard: result.orderCard ?? null,
        dealCard: result.dealCard ?? null,
      });
    } catch (err) {
      console.error('[ai] chat failed:', err);
      return res.status(502).json({ error: 'ai_failed', message: 'The assistant could not complete the request.' });
    }
  },
);

const confirmSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.unknown()),
  pendingActionId: z.string().uuid().optional(),
});

/** Approving from the Approval Inbox holds a DIFFERENT permission than the
 *  inline "confirm your own just-proposed action" chat flow (spec §29's own
 *  distinction between proposing/executing and approving) — either is
 *  accepted here so someone who only ever approves (never chats) can still
 *  act from the Inbox. */
function canActOnAiActions(permissions: string[], role: string | null): boolean {
  return permits(permissions, role, 'ai.execute_write') || permits(permissions, role, 'ai.approve_sensitive_action');
}

/**
 * POST /api/ai/confirm — executes exactly one AI-proposed action after a
 * human taps Confirm (either inline in the proposing chat, or from the
 * Approval Inbox). Re-checks the permission and re-validates the target
 * from scratch (never trusts the request body's word that it's still valid);
 * the mutation itself still runs through the same RPC a staff member would
 * use, so it is subject to the same business rules. Logged distinctly from
 * both a normal AI read (`ai.tool`) and a normal staff edit. When
 * pendingActionId is given, the persisted ai_pending_actions row (spec §29)
 * is updated to match the outcome — approved/expired/failed — so the Inbox
 * never shows something already resolved as still pending.
 */
aiRouter.post(
  '/confirm',
  express.json(),
  requirePortalPerm('ai.view'),
  async (req: Request, res: Response) => {
    if (!aiEnabled) {
      return res
        .status(503)
        .json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });

    const { admin, permissions, role, userId, email } = req.tenant!;
    const action = AI_ACTIONS.find((a) => a.name === parsed.data.name);
    if (!action) return res.status(404).json({ error: 'unknown_action' });
    if (!canActOnAiActions(permissions, role) || !permits(permissions, role, action.needs)) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not allowed to confirm this action.' });
    }
    const pendingId = parsed.data.pendingActionId;

    const described = await action.describe(admin, parsed.data.args);
    if (!described.ok) {
      if (pendingId) {
        await admin
          .from('ai_pending_actions')
          .update({ status: 'expired', error: described.error, resolved_at: new Date().toISOString(), resolved_by: userId, resolved_by_email: email })
          .eq('id', pendingId)
          .eq('status', 'pending');
      }
      return res.status(409).json({ error: 'stale', message: described.error });
    }
    try {
      const result = await action.run(admin, parsed.data.args);
      // generate_report can't know the restaurant's display name (the
      // tenant DB has no such field, same gap SYSTEM_PROMPT already works
      // around with the slug) — this route has the real slug in scope, the
      // action doesn't, so it's patched in here rather than threading a
      // new parameter through every action's signature for one action's sake.
      if (action.name === 'generate_report' && result && typeof result === 'object' && 'restaurantName' in result) {
        (result as { restaurantName: string }).restaurantName = req.tenant!.slug;
      }
      if (action.name === 'generate_report' && result && typeof result === 'object' && 'periodLabel' in result) {
        const { from, to } = resolvePeriod(parsed.data.args);
        await logExportAudit(admin, {
          format: 'pdf',
          periodLabel: (result as { periodLabel: string }).periodLabel,
          from,
          to,
          userId,
          email,
          role,
          status: 'ready',
        });
      }
      await admin.from('audit_logs').insert({
        actor_id: userId,
        actor_email: email,
        actor_role: role,
        action: 'ai.action_executed',
        entity: action.name,
        after: { args: parsed.data.args, summary: described.summary },
      });
      if (pendingId) {
        // The .eq('status', 'pending') guard makes this a no-op if the row
        // was already resolved elsewhere (e.g. rejected from the Inbox
        // moments before this same proposal was confirmed inline in chat)
        // — the row keeps whichever resolution landed first rather than
        // being silently overwritten.
        await admin
          .from('ai_pending_actions')
          .update({ status: 'approved', result: result ?? null, resolved_at: new Date().toISOString(), resolved_by: userId, resolved_by_email: email })
          .eq('id', pendingId)
          .eq('status', 'pending');
      }
      return res.json({ ok: true, message: `Done — ${described.summary}`, result: result ?? null });
    } catch (err) {
      console.error('[ai] confirm failed:', err);
      const message = String((err as Error).message ?? err).slice(0, 300);
      if (action.name === 'generate_report' || action.name === 'export_excel_report') {
        const { from, to, label } = resolvePeriod(parsed.data.args);
        await logExportAudit(admin, {
          format: action.name === 'generate_report' ? 'pdf' : 'excel',
          periodLabel: label,
          from,
          to,
          userId,
          email,
          role,
          status: 'failed',
          error: message,
        });
      }
      if (pendingId) {
        await admin
          .from('ai_pending_actions')
          .update({ status: 'failed', error: message, resolved_at: new Date().toISOString(), resolved_by: userId, resolved_by_email: email })
          .eq('id', pendingId)
          .eq('status', 'pending');
      }
      return res.status(502).json({ error: 'action_failed', message });
    }
  },
);

const pendingRejectSchema = z.object({ slug: z.string().min(1) });

/**
 * POST /api/ai/pending/:id/reject — declines a persisted proposal without
 * executing it. Lower bar than confirm (nothing is mutated), so only the
 * broad ai.execute_write gate is required, not the specific action's own
 * business permission or ai.approve_sensitive_action — matching how
 * cancelling your own proposal inline in chat has always worked.
 */
aiRouter.post(
  '/pending/:id/reject',
  express.json(),
  requirePortalPerm('ai.view'),
  async (req: Request, res: Response) => {
    const parsed = pendingRejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
    const { admin, permissions, role, userId, email } = req.tenant!;
    if (!permits(permissions, role, 'ai.execute_write')) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not allowed to act on AI proposals.' });
    }
    const { data, error } = await admin
      .from('ai_pending_actions')
      .update({ status: 'rejected', resolved_at: new Date().toISOString(), resolved_by: userId, resolved_by_email: email })
      .eq('id', req.params.id)
      .eq('status', 'pending')
      .select('id, action_name, summary')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'reject_failed', message: error.message });
    if (!data) return res.status(409).json({ error: 'not_pending', message: 'This proposal was already resolved.' });
    await admin.from('audit_logs').insert({
      actor_id: userId,
      actor_email: email,
      actor_role: role,
      action: 'ai.action_rejected',
      entity: data.action_name,
      entity_id: data.id,
      after: { summary: data.summary },
    });
    return res.json({ ok: true });
  },
);

/**
 * GET /api/ai/pending — the Approval Inbox (spec §29): every currently
 * pending AI-proposed action across the whole restaurant, not just the one
 * chat that happened to propose it. Gated by ai.approve_sensitive_action —
 * a narrower bar than ai.execute_write (which only lets you act on a
 * proposal you already know about) — so only an authorized approver can
 * discover the full queue.
 */
const REPORT_PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month'];

aiRouter.get('/pending', requirePortalPerm('ai.approve_sensitive_action'), async (req: Request, res: Response) => {
  const { admin, permissions, role } = req.tenant!;
  const { data, error } = await admin
    .from('ai_pending_actions')
    .select('id, action_name, args, summary, status, proposed_by_email, proposed_by_role, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: 'pending_fetch_failed', message: error.message });
  const items = data ?? [];

  // For a pending generate_report proposal, an approver should see the
  // real numbers before approving it, not just the summary sentence —
  // same drill-down card the AI chat shows on its own profitability
  // answers (spec: one calculation, several surfaces). Fetched here
  // rather than stored on the row itself, so it's always current as of
  // the moment someone actually opens the Inbox, not stale from whenever
  // it was proposed. Silently omitted if the approver can't see profit —
  // the row (and Approve/Reject) still works either way.
  if (permits(permissions, role, 'finance.view_profit') || permits(permissions, role, 'finance.view_cogs') || permits(permissions, role, 'inventory.view_cost')) {
    await Promise.all(
      items.map(async (item) => {
        if (item.action_name !== 'generate_report') return;
        const period = String((item.args as Record<string, unknown> | null)?.period ?? '');
        if (!REPORT_PERIODS.includes(period)) return;
        const { from, to, label } = periodRange(period as Period);
        const { data: rows } = await admin.rpc('period_profitability', { p_from: from.toISOString(), p_to: to.toISOString() });
        const row = (rows as Record<string, unknown>[] | null)?.[0];
        if (row) (item as Record<string, unknown>).profitCard = { period: label, from_ts: from.toISOString(), to_ts: to.toISOString(), ...row };
      }),
    );
  }

  return res.json({ items });
});

/**
 * GET /api/ai/export/excel — the Restaurant Performance & Owner Activity
 * Intelligence Excel export (spec's "PDF & Excel Export" system). Unlike
 * the PDF (built client-side from JSON the API already sends), the
 * workbook is generated here on the server via ExcelJS and streamed
 * directly — a real multi-sheet .xlsx, not a renamed CSV. Gated by
 * reports.export, distinct from reports.generate (the PDF) since an
 * accountant-facing detailed export is a materially bigger data exposure
 * than a summary PDF and some roles may be trusted with one but not the
 * other. Tenancy is resolved server-side by requirePortalPerm from :slug —
 * a caller can never point this at another restaurant's data by editing
 * the query string.
 */
aiRouter.get('/export/excel', requirePortalPerm('reports.export'), async (req: Request, res: Response) => {
  const { admin, slug, userId, email, role } = req.tenant!;
  const range = resolvePeriod({ period: req.query.period, from: req.query.from, to: req.query.to });
  try {
    // Custom Export (spec §37): ?sheets=Orders,Expenses,Inventory picks
    // which optional sheets to include; omit for the full 16-sheet
    // workbook. Always sends the anchor sheets (Executive Summary, Profit
    // Summary, Verification) regardless.
    const sheetsParam = typeof req.query.sheets === 'string' ? req.query.sheets : undefined;
    const includeSheets = sheetsParam
      ? sheetsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const built = await buildExcelWorkbook(
      admin,
      slug,
      {
        period: req.query.period,
        from: req.query.from,
        to: req.query.to,
      },
      includeSheets,
    );
    if (!built.ok) {
      await logExportAudit(admin, { format: 'excel', periodLabel: range.label, from: range.from, to: range.to, sheets: includeSheets, userId, email, role, status: 'failed', error: built.error });
      return res.status(409).json({ error: 'export_failed', message: built.error });
    }
    const buffer = await built.workbook.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-export-${stamp}.xlsx"`);
    res.send(Buffer.from(buffer));
    await logExportAudit(admin, { format: 'excel', periodLabel: built.periodLabel, from: range.from, to: range.to, sheets: includeSheets, userId, email, role, status: 'ready' });
  } catch (err) {
    console.error('[ai] excel export failed:', err);
    await logExportAudit(admin, { format: 'excel', periodLabel: range.label, from: range.from, to: range.to, userId, email, role, status: 'failed', error: String((err as Error).message ?? err).slice(0, 300) });
    res.status(500).json({ error: 'export_failed', message: String((err as Error).message ?? err).slice(0, 300) });
  }
});

/**
 * GET /api/ai/export-history — the "Report & Export History" page (spec
 * §41): every PDF/Excel export this tenant has generated, most recent
 * first. Reads export_audit_log directly (RLS already scopes it to
 * staff/reports permissions) rather than a second permission check here.
 * Returns an empty list (not an error) when the table doesn't exist yet on
 * a tenant that hasn't received tenant-migrations/0037 — same
 * non-fatal-by-design posture as logExportAudit's own write side, so a
 * not-yet-migrated tenant sees an empty history page instead of a broken one.
 */
aiRouter.get('/export-history', requirePortalPerm('reports.view'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const { data, error } = await admin
    .from('export_audit_log')
    .select('id, format, period_label, period_from, period_to, sheets, requested_by_email, requested_by_role, status, error, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn('[ai] export history read failed (export_audit_log likely not migrated yet):', error.message);
    return res.json({ items: [], migrated: false });
  }
  res.json({ items: data ?? [], migrated: true });
});

/**
 * GET /api/ai/intelligence — powers the Dashboard's Restaurant Intelligence
 * panel (the Owner Scorecard, Attention Items, Positive Highlights, Areas
 * to Review and Money Flow the master spec's §25 dashboard layout asked
 * for) as a plain page load rather than something only reachable by typing
 * a chat question. Calls analyze_restaurant's own run() directly — same
 * pattern as /attention calling computeAttentionItems() directly — so the
 * numbers on this page are always exactly what the AI chat would say for
 * the same period, never a second computation.
 */
aiRouter.get('/intelligence', requirePortalPerm('analytics.view'), async (req: Request, res: Response) => {
  const { admin } = req.tenant!;
  const tool = AI_TOOLS.find((t) => t.name === 'analyze_restaurant');
  if (!tool) return res.status(500).json({ error: 'tool_missing' });
  try {
    const result = await tool.run(admin, { period: req.query.period, from: req.query.from, to: req.query.to });
    res.json(result);
  } catch (err) {
    console.error('[ai] intelligence fetch failed:', err);
    res.status(500).json({ error: 'intelligence_fetch_failed', message: String((err as Error).message ?? err).slice(0, 300) });
  }
});
