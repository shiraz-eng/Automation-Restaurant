'use client';

import { useRef, useState } from 'react';
import { formatCents } from '@/lib/format';
import type { Product, ModOption, DealMatch, DealLite } from './StorefrontClient';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type ChatMsg = { role: 'user' | 'assistant'; content: string };

// Renderable pieces the assistant's tool calls can surface — extracted from
// the raw trace/tool JSON the backend returns, never invented client-side.
// Every number and id here comes straight from a tool result.
type DealCard = { deal_id: string; deal_name: string; status: string; individual_total_cents: number; deal_total_cents: number; savings_cents: number; missing?: string };
type ResolvedCard = { menu_item_id: string; item_name: string; variant_id: string | null; variant_name: string | null; available: boolean; modifier_option_ids: string[]; resolved_modifiers: { name: string; price_cents: number }[]; unit_price_cents: number | null };
type BudgetCard = { items: { variant_id: string; name: string; qty: number; unit_price_cents: number }[]; deal: { deal_id: string; name: string; price_cents: number; qty: number } | null; subtotal_cents: number };

export function CustomerAiChat({
  slug,
  restaurantName,
  products,
  deals,
  cartSnapshot,
  dealMatches,
  onAddPlain,
  onAddConfigured,
  onUseDealMatch,
  onUseAlmostMatch,
  onAddDealPlain,
  hideTrigger,
}: {
  slug: string;
  restaurantName: string;
  products: Product[];
  deals: DealLite[];
  cartSnapshot: { variant_id: string; qty: number }[];
  dealMatches: DealMatch[];
  onAddPlain: (product: Product, qty: number) => void;
  onAddConfigured: (product: Product, modifierIds: string[], modifierSnapshot: ModOption[]) => void;
  onUseDealMatch: (match: DealMatch) => void;
  onUseAlmostMatch: (match: DealMatch) => void;
  onAddDealPlain: (deal: DealLite, qty: number) => void;
  /** Hide the floating trigger while another full-screen sheet (cart, item
   *  detail, deal detail) is open on top of it — the chat panel itself
   *  (once opened) still renders above everything, unaffected. */
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [dealCards, setDealCards] = useState<Record<number, DealCard[]>>({});
  const [resolvedCards, setResolvedCards] = useState<Record<number, ResolvedCard[]>>({});
  const [budgetCards, setBudgetCards] = useState<Record<number, BudgetCard>>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  function scrollToBottom() {
    requestAnimationFrame(() => {
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
    });
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError(null);
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    setBusy(true);
    scrollToBottom();
    try {
      // The full tool-calling assistant (deal matching, item resolution,
      // budget proposals as action cards) lives behind the Express API —
      // unreachable in production as a browser fetch (see guideAi.ts's
      // same fix). Fall back to a same-origin, plain-text-only version
      // using the menu data already loaded on this page, rather than
      // showing "Network error" for every question.
      const useExpress = typeof window === 'undefined' || (API && !API.includes('localhost:4000'));
      const endpoint = useExpress ? `${API}/api/public/ai/chat` : '/api/order/ai';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          useExpress
            ? { slug, restaurant_name: restaurantName, messages: next.slice(-10), cart_lines: cartSnapshot }
            : {
                restaurant_name: restaurantName,
                messages: next.slice(-10),
                menu_items: products.map((p) => ({ name: p.name, price_cents: p.price_cents })),
                menu_deals: deals.map((d) => ({ name: d.name, price_cents: d.price_cents, description: d.description })),
              },
        ),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? "Couldn't reach the assistant.");
        setBusy(false);
        return;
      }
      const replyIndex = next.length; // index this assistant message will occupy
      setMessages((m) => [...m, { role: 'assistant', content: body.reply }]);
      // Structured evidence the backend's tool calls actually returned —
      // rendered as real action cards, never re-derived from the model's prose.
      if (body.dealCards) setDealCards((c) => ({ ...c, [replyIndex]: body.dealCards }));
      if (body.resolvedCards) setResolvedCards((c) => ({ ...c, [replyIndex]: body.resolvedCards }));
      if (body.budgetCard) setBudgetCards((c) => ({ ...c, [replyIndex]: body.budgetCard }));
      scrollToBottom();
    } catch {
      setError('Network error — try again.');
    } finally {
      setBusy(false);
    }
  }

  function addResolved(card: ResolvedCard, msgIndex: number, cardIndex: number) {
    if (!card.variant_id) return;
    const product = products.find((p) => p.id === card.variant_id);
    if (!product) return;
    const key = `${msgIndex}:${cardIndex}`;
    if (card.modifier_option_ids.length > 0) {
      const modifierSnapshot = product.modifier_groups
        .flatMap((g) => g.modifier_options)
        .filter((o) => card.modifier_option_ids.includes(o.id));
      onAddConfigured(product, card.modifier_option_ids, modifierSnapshot);
    } else {
      onAddPlain(product, 1);
    }
    setAddedKeys((s) => new Set(s).add(key));
  }

  function useDeal(card: DealCard) {
    const match = dealMatches.find((m) => m.deal.id === card.deal_id);
    if (!match) return;
    if (card.status === 'eligible_now') onUseDealMatch(match);
    else onUseAlmostMatch(match);
  }

  function addBudgetProposal(card: BudgetCard) {
    for (const it of card.items) {
      const product = products.find((p) => p.id === it.variant_id);
      if (product) onAddPlain(product, it.qty);
    }
    if (card.deal) {
      const deal = deals.find((d) => d.id === card.deal!.deal_id);
      if (deal) onAddDealPlain(deal, card.deal.qty);
    }
  }

  const suggestions = ['What are your best sellers?', "What's the best deal right now?", 'Something under Rs. 1000?'];

  return (
    <>
      {!hideTrigger && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-24 lg:bottom-6 right-4 lg:right-[404px] z-40 rounded-full bg-primary text-primary-fg w-[52px] h-[52px] shadow-lg shadow-black/20 grid place-items-center text-xl font-bold active:scale-95 transition-transform"
          aria-label="Ask the ordering assistant"
        >
          ✦
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-main flex flex-col lg:items-center lg:justify-center lg:bg-black/50">
          <div className="flex flex-col w-full h-full lg:h-[85vh] lg:max-w-md lg:rounded-2xl lg:border lg:border-border lg:shadow-2xl overflow-hidden bg-main">
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-full bg-primary text-primary-fg grid place-items-center text-sm font-bold shrink-0">✦</span>
              <div>
                <div className="font-bold text-sm">Ask about the menu</div>
                <div className="text-muted text-[10.5px]">Recommendations only — you confirm before anything&rsquo;s added</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-muted hover:text-body text-xl leading-none px-2" aria-label="Close">
              ×
            </button>
          </div>

          <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-muted text-xs">Try asking:</p>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full text-left rounded-xl border border-border px-3.5 py-2.5 text-xs hover:border-primary/40 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                    m.role === 'user' ? 'bg-primary text-primary-fg' : 'bg-surface border border-border'
                  }`}
                >
                  {m.content}
                  {dealCards[i]?.map((card, ci) => (
                    <div key={ci} className="mt-2 rounded-xl border border-ok/50 bg-ok/10 p-2.5">
                      <div className="font-bold text-[11px]">{card.deal_name}</div>
                      <div className="text-[11px]">
                        {formatCents(card.individual_total_cents)} individually → {formatCents(card.deal_total_cents)} as a combo
                      </div>
                      <div className="text-[11px] font-bold text-ok">Save {formatCents(card.savings_cents)}</div>
                      {card.status === 'one_item_away' && card.missing && (
                        <div className="text-[11px] text-muted">Add {card.missing} to qualify.</div>
                      )}
                      <button
                        onClick={() => useDeal(card)}
                        className="mt-1.5 rounded-full bg-primary text-primary-fg text-[11px] font-bold px-3 py-1.5"
                      >
                        {card.status === 'eligible_now' ? 'Use Deal' : 'Add & Switch'}
                      </button>
                    </div>
                  ))}
                  {resolvedCards[i]?.map((card, ci) => (
                    <div key={ci} className="mt-2 rounded-xl border border-border bg-surface p-2.5">
                      <div className="font-bold text-[11px]">
                        {card.item_name}
                        {card.variant_name ? ` · ${card.variant_name}` : ''}
                      </div>
                      {card.resolved_modifiers.length > 0 && (
                        <div className="text-[11px] text-muted">+ {card.resolved_modifiers.map((m2) => m2.name).join(', ')}</div>
                      )}
                      {card.available && card.unit_price_cents != null ? (
                        <>
                          <div className="text-[11px]">{formatCents(card.unit_price_cents)}</div>
                          <button
                            onClick={() => addResolved(card, i, ci)}
                            disabled={addedKeys.has(`${i}:${ci}`)}
                            className="mt-1.5 rounded-full bg-primary text-primary-fg text-[11px] font-bold px-3 py-1.5 disabled:opacity-50"
                          >
                            {addedKeys.has(`${i}:${ci}`) ? 'Added' : 'Add to cart'}
                          </button>
                        </>
                      ) : (
                        <div className="text-[11px] text-danger">Not currently available.</div>
                      )}
                    </div>
                  ))}
                  {budgetCards[i] && (
                    <div className="mt-2 rounded-xl border border-border bg-surface p-2.5">
                      <div className="font-bold text-[11px] mb-1">Suggested order</div>
                      <ul className="text-[11px] space-y-0.5">
                        {budgetCards[i].items.map((it, ii) => (
                          <li key={ii} className="flex justify-between">
                            <span>{it.qty}× {it.name}</span>
                            <span>{formatCents(it.unit_price_cents * it.qty)}</span>
                          </li>
                        ))}
                        {budgetCards[i].deal && (
                          <li className="flex justify-between font-semibold">
                            <span>{budgetCards[i].deal!.qty}× {budgetCards[i].deal!.name}</span>
                            <span>{formatCents(budgetCards[i].deal!.price_cents * budgetCards[i].deal!.qty)}</span>
                          </li>
                        )}
                      </ul>
                      <div className="text-[11px] font-bold mt-1">Subtotal {formatCents(budgetCards[i].subtotal_cents)}</div>
                      <button
                        onClick={() => addBudgetProposal(budgetCards[i])}
                        className="mt-1.5 rounded-full bg-primary text-primary-fg text-[11px] font-bold px-3 py-1.5"
                      >
                        Add all to cart
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-muted text-xs">Thinking…</div>}
            {error && <div className="text-danger text-xs">{error}</div>}
          </div>

          <div className="border-t border-border p-3 flex gap-2 shrink-0">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="Ask about the menu…"
              className="flex-1 min-w-0 rounded-full border border-border bg-surface px-4 py-2.5 text-sm outline-none focus:border-primary transition-colors"
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim()}
              className="rounded-full bg-primary text-primary-fg font-bold px-5 text-sm disabled:opacity-50 active:scale-95 transition-transform"
            >
              Ask
            </button>
          </div>
          </div>
        </div>
      )}
    </>
  );
}
