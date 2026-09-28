/**
 * Calls POST /api/ai/chat with stream: true and reads its server-sent
 * events: `status` (what it's looking up), `delta` (answer text as it's
 * written), then `done` (the full result: reply, tools, cards, proposed
 * action) or `error`. Shared by the Assistant page and the dashboard's
 * "Ask AI" box.
 */
export type AiStreamResult =
  | { ok: true; done: Record<string, unknown> }
  | { ok: false; error: string; code?: string };

export async function streamAiChat(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  on: { status?: (label: string) => void; delta?: (text: string) => void },
): Promise<AiStreamResult> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
  } catch {
    return { ok: false, error: 'Network error — check your connection and try again.' };
  }
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    return { ok: false, code: j.error, error: j.message ?? j.error ?? 'The assistant failed.' };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        }
        if (!data) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event === 'status') on.status?.(String(parsed.label ?? ''));
        else if (event === 'delta') on.delta?.(String(parsed.text ?? ''));
        else if (event === 'done') return { ok: true, done: parsed };
        else if (event === 'error') return { ok: false, code: String(parsed.error ?? ''), error: String(parsed.message ?? 'The assistant failed.') };
      }
    }
  } catch {
    return { ok: false, error: 'The connection dropped before the answer finished — please try again.' };
  }
  return { ok: false, error: 'The connection closed before the answer finished — please try again.' };
}
