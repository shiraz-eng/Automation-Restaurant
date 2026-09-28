'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Markdown } from '@/components/Markdown';

type Chat = { id: string; title: string; updated_at: string; message_count: number };
type Message = { role: 'user' | 'assistant'; content: string; created_at: string };

/**
 * What guests asked the ordering assistant on the online menu (saved by
 * routes/customerAi.ts, tenant-migrations/0081). Read-only; visible to staff
 * who may view customers (the table's own RLS enforces that).
 */
export function CustomerChats() {
  const supabase = usePortalSupabase();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || chats) return;
    supabase
      .from('ai_conversations')
      .select('id, title, updated_at, message_count')
      .eq('kind', 'customer')
      .order('updated_at', { ascending: false })
      .limit(200)
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setChats((data as Chat[] | null) ?? []);
      });
  }, [open, chats, supabase]);

  async function show(id: string) {
    setSelected(id);
    setMessages(null);
    const { data, error: err } = await supabase
      .from('ai_messages')
      .select('role, content, created_at')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    if (err) setError(err.message);
    else setMessages((data as Message[] | null) ?? []);
  }

  const shown = (chats ?? []).filter((c) => !filter.trim() || c.title.toLowerCase().includes(filter.trim().toLowerCase()));
  const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <section className="rounded-lg border border-border bg-surface">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-left">
        <span>
          <span className="font-bold text-sm">Customer chats</span>
          <span className="block text-muted text-[11px]">What guests asked the ordering assistant on your online menu</span>
        </span>
        <span className="text-muted text-xs">{open ? 'Hide ▴' : 'Show ▾'}</span>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          {error && <p className="text-danger text-xs mb-2">{error}</p>}
          {!chats ? (
            <p className="text-muted text-xs">Loading…</p>
          ) : chats.length === 0 ? (
            <p className="text-muted text-xs">No customer chats yet. They appear here once guests use the ✦ assistant on your menu.</p>
          ) : (
            <div className="grid md:grid-cols-[minmax(0,14rem)_1fr] gap-3">
              <div className="space-y-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Search ${chats.length} chats…`}
                  className="w-full rounded border border-border bg-main px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                />
                <div className="max-h-[50vh] overflow-y-auto rounded border border-border">
                  {shown.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => show(c.id)}
                      className={`block w-full text-left px-2.5 py-2 border-b border-border/60 last:border-0 ${selected === c.id ? 'bg-primary/10' : 'hover:bg-main'}`}
                    >
                      <div className="text-xs font-semibold truncate">{c.title}</div>
                      <div className="text-[10px] text-muted">
                        {when(c.updated_at)} · {c.message_count} messages
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[56vh] overflow-y-auto rounded border border-border p-3 space-y-2">
                {!selected ? (
                  <p className="text-muted text-xs">Pick a chat to read it.</p>
                ) : !messages ? (
                  <p className="text-muted text-xs">Loading…</p>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                      <div
                        className={`inline-block max-w-[90%] rounded-lg px-3 py-2 text-xs text-left ${
                          m.role === 'user' ? 'bg-primary text-primary-fg whitespace-pre-wrap' : 'bg-main border border-border'
                        }`}
                      >
                        {m.role === 'user' ? m.content : <Markdown text={m.content} />}
                      </div>
                      <div className="text-[10px] text-muted mt-0.5">
                        {m.role === 'user' ? 'Guest' : 'Assistant'} · {when(m.created_at)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
