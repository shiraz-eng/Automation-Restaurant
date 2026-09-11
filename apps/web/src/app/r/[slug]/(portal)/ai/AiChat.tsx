'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Msg = { role: 'user' | 'assistant'; content: string; tools?: string[] };

const SUGGESTIONS = [
  'How is my restaurant doing right now?',
  'What needs my attention?',
  'What are our best-selling items this week?',
  'How is attendance today?',
  'What are customers saying about speed?',
  'How did yesterday close out?',
];

export function AiChat({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput('');
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setBusy(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({
          slug,
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.error === 'ai_not_configured'
            ? 'The assistant is not configured — add a GEMINI_API_KEY or ANTHROPIC_API_KEY to the API server.'
            : (body.message ?? body.error ?? 'The assistant failed.'),
        );
        return;
      }
      setMsgs((m) => [
        ...m,
        {
          role: 'assistant',
          content: body.reply ?? '(no answer)',
          tools: (body.tools ?? []).map((x: { name: string }) => x.name),
        },
      ]);
      requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface flex flex-col h-[65vh]">
      <div ref={boxRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {msgs.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted text-xs">Try asking:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="block text-left text-xs rounded border border-border px-3 py-2 hover:border-primary"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
              <div
                className={`inline-block rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[85%] ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-fg'
                    : 'bg-main border border-border'
                }`}
              >
                {m.content}
              </div>
              {m.tools && m.tools.length > 0 && (
                <div className="text-[10px] text-muted mt-1">
                  · {m.tools.join(' · ')}
                </div>
              )}
            </div>
          ))
        )}
        {busy && <p className="text-muted text-xs">Thinking…</p>}
        {error && <p className="text-danger text-xs">{error}</p>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border p-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the assistant…"
          className="flex-1 rounded border border-border bg-main px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded bg-primary text-primary-fg font-semibold px-4 py-2 text-sm disabled:opacity-50"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
