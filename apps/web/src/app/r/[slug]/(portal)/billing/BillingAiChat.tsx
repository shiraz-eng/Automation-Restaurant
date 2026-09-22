'use client';

import { useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input } from '@/components/ui';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Msg = { role: 'user' | 'assistant'; content: string };

const STARTERS = ['What plan am I on?', 'When does my subscription renew?', 'What would I get on a higher plan?'];

/** The billing/subscription assistant — separate from the operational
 *  assistant inside the portal, and architecturally unable to answer
 *  anything about orders/menu/inventory/staff (its tools only ever touch
 *  the control plane, see apps/api/src/lib/saasAiTools.ts). */
export function BillingAiChat({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const supabase = usePortalSupabase();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${API}/api/saas-ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ slug, restaurant_name: restaurantName, messages: next }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.message ?? 'The billing assistant is not available right now.');
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: body.reply }]);
  }

  return (
    <Card>
      <h2 className="font-bold text-sm mb-1">Ask about your billing</h2>
      <p className="text-muted text-xs mb-3">
        Plan and subscription questions only — for orders, menu, or staff, use the assistant inside the portal.
      </p>

      {messages.length === 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {STARTERS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:border-primary"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <div className="space-y-2 mb-3 max-h-64 overflow-y-auto">
          {messages.map((m, i) => (
            <div key={i} className={`text-xs rounded-lg px-3 py-2 max-w-[85%] ${m.role === 'user' ? 'ml-auto bg-primary text-primary-fg' : 'bg-surface border border-border'}`}>
              {m.content}
            </div>
          ))}
          {busy && <div className="text-muted text-xs">Thinking…</div>}
        </div>
      )}

      {error && <p className="text-danger text-xs mb-2">{error}</p>}

      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && input.trim() && !busy) send(input.trim());
          }}
          placeholder="Ask a billing question…"
          className="flex-1"
        />
        <Button onClick={() => input.trim() && send(input.trim())} disabled={busy || !input.trim()}>
          Ask
        </Button>
      </div>
    </Card>
  );
}
