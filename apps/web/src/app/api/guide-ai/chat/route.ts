import { z } from 'zod';
import { buildSystemPrompt, fallbackAnswer } from './knowledge';
import { instantAnswer, closestAnswer } from './instantAnswers';

// The AI Guide for the public site and the restaurant portal. Streams the
// answer as plain text so the first words show up within about a second,
// instead of waiting for the whole reply. The model ends every answer with
// a "[[SUGGEST]] a | b | c" line that the panel turns into follow-up chips.
//
// No account data is read here — the guide explains and troubleshoots from
// the knowledge in ./knowledge.ts. Restaurant name/plan/page in the request
// only personalise wording; nothing is authorised from them.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

// Recent turns are enough context for a help chat, and a shorter request is
// a faster one.
const MAX_TURNS = 10;

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(60),
  context: z
    .object({
      mode: z.enum(['public', 'portal']).optional(),
      page: z.string().max(300).optional(),
      slug: z.string().max(80).optional(),
      restaurantName: z.string().max(120).optional(),
      planTier: z.string().max(40).optional(),
      subscriptionStatus: z.string().max(40).optional(),
    })
    .optional(),
});

type Action = { label: string; type: 'link'; href: string };

/** Quick links shown under the answer, picked from what the user asked. */
function actionsFor(question: string, ctx: z.infer<typeof chatSchema>['context']): Action[] {
  const q = question.toLowerCase();
  const base = ctx?.mode === 'portal' && ctx.slug ? `/r/${ctx.slug}` : null;
  const out: Action[] = [];
  if (!base) {
    if (/price|plan|cost|pricing|trial/.test(q)) out.push({ label: 'View pricing', type: 'link', href: '/pricing' });
    if (/start|sign ?up|register|setup|set up|supabase|begin|account/.test(q))
      out.push({ label: 'Get started', type: 'link', href: '/get-started' });
    if (/support|contact|help|stuck|failed|error/.test(q)) out.push({ label: 'Contact support', type: 'link', href: '/contact' });
    return out.slice(0, 2);
  }
  const map: [RegExp, string, string][] = [
    [/menu|import|dish|item/, 'Open Menu', '/menu'],
    [/portal|login for|station|permission/, 'Open Portals', '/portals'],
    [/priority|allocation|percent/, 'Priority Allocation', '/menu/priority'],
    [/deal|combo|bundle/, 'Deals & Combos', '/deals'],
    [/inventory|stock|restock|ingredient/, 'Open Inventory', '/inventory'],
    [/recipe|food cost/, 'Recipes & Food Cost', '/recipes'],
    [/staff|employee|team|role/, 'Open Staff', '/staff'],
    [/table|qr/, 'Tables & QR', '/tables'],
    [/kitchen|kds|kot/, 'Kitchen display', '/kds'],
    [/brand|logo|receipt|colour|color/, 'Brand Kit', '/settings/theme'],
    [/smart import|ai import|photo|pdf/, 'Smart Import', '/ai'],
  ];
  for (const [re, label, path] of map) if (re.test(q)) out.push({ label, type: 'link', href: `${base}${path}` });
  return out.slice(0, 2);
}

export async function POST(req: Request) {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const parsed = chatSchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const { context } = parsed.data;
  const messages = parsed.data.messages.slice(-MAX_TURNS);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    'X-Guide-Actions': encodeURIComponent(JSON.stringify(actionsFor(lastUser, context))),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentAny = false;
      const push = (t: string) => {
        if (!t) return;
        sentAny = true;
        controller.enqueue(encoder.encode(t));
      };
      // Recommended questions (and their follow-up chips) have pre-written
      // answers: shown instantly, no AI round trip.
      const instant = instantAnswer(lastUser);
      if (instant) {
        push(instant);
        controller.close();
        return;
      }
      try {
        if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
        const body = (thinking: boolean) =>
          JSON.stringify({
            systemInstruction: { parts: [{ text: buildSystemPrompt(context) }] },
            contents: messages.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 700,
              // Current flash-lite models think before answering by default,
              // which costs ~10+ s before the first word. A help chat doesn't
              // need it; 'minimal' cut first-token time roughly 3× in testing.
              ...(thinking ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
            },
          });
        // Gemini's latency swings a lot (2 s one minute, 25 s the next). Give
        // each attempt a short window to START answering; a stalled or
        // overloaded attempt is abandoned and retried once instead of
        // leaving the user staring at dots.
        const call = async (thinking: boolean, startWithinMs: number) => {
          const ctrl = new AbortController();
          const startTimer = setTimeout(() => ctrl.abort(), startWithinMs);
          const hardStop = setTimeout(() => ctrl.abort(), 40000);
          try {
            const r = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
                body: body(thinking),
                signal: ctrl.signal,
              },
            );
            clearTimeout(startTimer);
            return r;
          } catch (e) {
            clearTimeout(hardStop);
            throw e;
          }
        };
        let res: Response | null = null;
        try {
          res = await call(true, 9000);
          // A model that doesn't accept the thinking setting answers 400.
          if (res.status === 400) res = await call(false, 9000);
        } catch {
          res = null;
        }
        if (!res || res.status === 429 || res.status >= 500) res = await call(false, 12000);
        if (!res.ok || !res.body) throw new Error(`gemini ${res.status}`);

        // Server-sent events: "data: {json}\n\n" per chunk.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
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
              };
              for (const part of evt.candidates?.[0]?.content?.parts ?? []) push(part.text ?? '');
            } catch {
              /* partial/keep-alive line */
            }
          }
        }
        if (!sentAny) throw new Error('empty reply');
      } catch {
        // Provider down or slow: answer from the built-in knowledge instead
        // of failing — but only if nothing has been streamed yet.
        if (!sentAny) {
          const close = closestAnswer(lastUser);
          push(
            close
              ? `Quick answer while the AI is busy:\n\n${close}`
              : fallbackAnswer(lastUser, context),
          );
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers });
}
