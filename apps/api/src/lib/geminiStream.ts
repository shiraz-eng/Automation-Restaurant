import type { Response } from 'express';
import { env } from '../env';

/**
 * Shared Gemini plumbing for the chat assistants (staff AI Assistant in
 * routes/ai.ts, customer ordering assistant in routes/customerAi.ts):
 * streamed answers, a fast model first with backups raced in, and
 * server-sent events to the browser.
 */

export type GPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: object } };
export type GContent = { role: 'user' | 'model'; parts: GPart[] };
/** Anything offered to the model as a callable function. */
export type GTool = { name: string; description: string; input_schema: { properties: Record<string, unknown> } };

/** Live progress for a streamed chat: lookups and answer text as it arrives. */
export type Emitter = { status: (label: string) => void; delta: (text: string) => void };
export const noEmit: Emitter = { status: () => {}, delta: () => {} };

// Models tried, fastest first. Measured 2026-09-28 on this key:
// gemini-3.1-flash-lite starts answering in ~2s, while the
// "gemini-flash-lite-latest" alias queued for 18-30s on the free tier, and
// gemini-flash-latest often returned 503 "high demand". The next model is
// raced in when the current one hasn't started answering after HEDGE_MS (or
// fails), and whichever answers first wins.
export const GEMINI_CHAT_MODELS = [...new Set(['gemini-3.1-flash-lite', env.GEMINI_MODEL, 'gemini-flash-latest'])];
const HEDGE_MS = 4000;
const MODEL_TIMEOUT_MS = 40_000;

/** Consecutive plain-text parts merged into one (anything carrying extra
 *  fields, e.g. a Gemini 3 thoughtSignature, is kept exactly as sent). */
function mergeTextParts(parts: GPart[]): GPart[] {
  const out: GPart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    const plain = (x: GPart | undefined) => !!x && 'text' in x && Object.keys(x).length === 1;
    if (plain(p) && plain(prev)) (prev as { text: string }).text += (p as { text: string }).text;
    else out.push({ ...p });
  }
  return out;
}

/** One streamed generateContent call. onParts sees each chunk as it arrives. */
async function geminiStreamOnce(model: string, body: object, signal: AbortSignal, onParts: (parts: GPart[]) => void): Promise<GContent> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-goog-api-key': env.GEMINI_API_KEY as string },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `gemini ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      message = j.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(`${model}: ${message}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts: GPart[] = [];
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
      const event = JSON.parse(line.slice(5)) as { candidates?: { content?: GContent }[]; error?: { code?: number; message?: string } };
      if (event.error) {
        const err = new Error(`${model}: ${event.error.message ?? 'stream error'}`);
        (err as { status?: number }).status = event.error.code;
        throw err;
      }
      const got = event.candidates?.[0]?.content?.parts ?? [];
      if (got.length) {
        parts.push(...got);
        onParts(got);
      }
    }
  }
  return { role: 'model', parts: mergeTextParts(parts) };
}

/** One model turn, raced across GEMINI_CHAT_MODELS: the next model starts if
 *  the current one hasn't produced anything after HEDGE_MS or fails; the
 *  first to stream anything wins and the others are cancelled. onText only
 *  ever receives the winner's text. */
function geminiTurnOnce(contents: GContent[], tools: GTool[], system: string, onText: (text: string) => void, generationConfig?: object): Promise<GContent> {
  const decls = tools.map((t) => ({
    name: t.name,
    description: t.description,
    ...(Object.keys(t.input_schema.properties).length ? { parameters: t.input_schema } : {}),
  }));
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
    ...(generationConfig ? { generationConfig } : {}),
  };
  return new Promise<GContent>((resolve, reject) => {
    let winner = -1;
    let settled = false;
    let started = 0;
    let failed = 0;
    let lastErr: unknown = new Error('no model available');
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
      if (settled || winner >= 0 || started >= GEMINI_CHAT_MODELS.length) return;
      const i = started++;
      const ctrl = new AbortController();
      ctrls[i] = ctrl;
      let timedOut = false;
      const kill = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, MODEL_TIMEOUT_MS);
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(startNext, HEDGE_MS);
      geminiStreamOnce(GEMINI_CHAT_MODELS[i]!, body, ctrl.signal, (parts) => {
        if (winner < 0) {
          winner = i;
          clearTimeout(hedgeTimer);
          cancelOthers(i);
        }
        if (winner !== i) return;
        for (const p of parts) if ('text' in p && p.text && !p.thought) onText(p.text);
      }).then(
        (content) => {
          clearTimeout(kill);
          if (winner === i || winner < 0) {
            cancelOthers(i);
            finish(() => resolve(content));
          }
        },
        (err) => {
          clearTimeout(kill);
          if (winner === i) return finish(() => reject(err));
          if (ctrl.signal.aborted && !timedOut) return; // cancelled because another model won
          failed++;
          lastErr = err;
          if (started < GEMINI_CHAT_MODELS.length) startNext();
          else if (failed === started && winner < 0) finish(() => reject(lastErr));
        },
      );
    };
    startNext();
  });
}

/** geminiTurnOnce, retried (with backoff) when every model is overloaded
 *  (429/503) — but never after text has reached the viewer, since it would
 *  then appear twice. */
export async function geminiTurn(
  contents: GContent[],
  tools: GTool[],
  system: string,
  onText: (text: string) => void,
  generationConfig?: object,
): Promise<GContent> {
  let emitted = false;
  const track = (t: string) => {
    emitted = true;
    onText(t);
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await geminiTurnOnce(contents, tools, system, track, generationConfig);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (emitted || attempt >= 2 || (status !== 429 && status !== 503)) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

/** Switches an Express response to server-sent events; returns send(). */
export function startSse(res: Response): (event: string, data: unknown) => void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A friendly message for an AI failure (Google overloaded vs anything else). */
export function aiFailureMessage(err: unknown): string {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 503
    ? "The AI service is busy right now — please try again in a minute."
    : 'The assistant could not complete the request — please try again.';
}
