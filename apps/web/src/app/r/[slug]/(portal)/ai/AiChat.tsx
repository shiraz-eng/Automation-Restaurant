'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
import { ProfitDrilldownModal, OrderDrilldownModal, DealDrilldownModal, type OrderProfitRow, type DealProfitRow } from '@/components/ProfitDrilldown';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type PendingAction = { id: string; name: string; args: Record<string, unknown>; summary: string };
type Resolution = 'confirmed' | 'cancelled' | 'failed';
// The exact period_profitability() row get_period_profitability returned
// to the model, captured verbatim server-side (routes/ai.ts) — never a
// second client-side fetch, so this card can never say something
// different from what the assistant's own reply just said.
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
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
  pendingAction?: PendingAction;
  resolution?: Resolution;
  resolutionMessage?: string;
  profitCard?: ProfitCard;
  orderCard?: OrderProfitRow;
  dealCard?: { period: string; deals: DealProfitRow[] };
};

const SUGGESTIONS = [
  'How is my restaurant doing right now?',
  'What needs my attention?',
  'How are sales this month vs last month?',
  'How is attendance this month?',
  'What are our best-selling items this week?',
  'What are customers saying about speed?',
];

export function AiChat({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drilldownCard, setDrilldownCard] = useState<ProfitCard | null>(null);
  const [orderDrilldown, setOrderDrilldown] = useState<OrderProfitRow | null>(null);
  const [dealDrilldown, setDealDrilldown] = useState<{ period: string; deals: DealProfitRow[] } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  function scrollDown() {
    requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
  }

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput('');
    const next: Msg[] = [...msgs, { role: 'user', content: q }];
    setMsgs(next);
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: await authHeader(),
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
          pendingAction: body.pendingAction ?? undefined,
          profitCard: body.profitCard ?? undefined,
          orderCard: body.orderCard ?? undefined,
          dealCard: body.dealCard ?? undefined,
        },
      ]);
      scrollDown();
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction(index: number, action: PendingAction) {
    setConfirming(index);
    try {
      const res = await fetch(`${API}/api/ai/confirm`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, name: action.name, args: action.args, pendingActionId: action.id || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      // generate_report is the one action that doesn't mutate anything —
      // its "result" is the report data itself, which this component turns
      // into a real PDF client-side (the same generateReportPdf() the
      // Dashboard's own "Generate Report" button calls), rather than the
      // server trying to produce/host a file.
      if (res.ok && action.name === 'generate_report' && body.result) {
        try {
          const { generateReportPdf } = await import('@/lib/generateReport');
          generateReportPdf(body.result);
        } catch (err) {
          console.error('PDF generation failed:', err);
        }
      }
      // export_excel_report only validates the range (it can't build the
      // workbook itself without a circular import — see aiTools.ts) and
      // hands back exactly what GET /api/ai/export/excel needs; the actual
      // .xlsx is fetched and downloaded here, same trigger-from-chat
      // pattern as the PDF above.
      if (res.ok && action.name === 'export_excel_report' && body.result?.ready) {
        try {
          const r = body.result as { from: string; to: string };
          // from/to are always both present and always take priority over
          // period in resolvePeriod() (aiTools.ts) — passing the exact
          // resolved range here, not the period name, is what keeps this
          // download identical to the range export_excel_report validated.
          const qs = new URLSearchParams({ slug, from: r.from, to: r.to });
          const dl = await fetch(`${API}/api/ai/export/excel?${qs.toString()}`, { headers: await authHeader() });
          if (dl.ok) {
            const blob = await dl.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${slug}-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }
        } catch (err) {
          console.error('Excel export download failed:', err);
        }
      }
      setMsgs((m) =>
        m.map((msg, i) =>
          i === index
            ? {
                ...msg,
                resolution: res.ok ? 'confirmed' : 'failed',
                resolutionMessage: res.ok ? body.message : (body.message ?? 'Could not complete that.'),
              }
            : msg,
        ),
      );
      scrollDown();
    } catch {
      setMsgs((m) =>
        m.map((msg, i) => (i === index ? { ...msg, resolution: 'failed', resolutionMessage: 'Network error.' } : msg)),
      );
    } finally {
      setConfirming(null);
    }
  }

  function cancelAction(index: number, action: PendingAction) {
    setMsgs((m) =>
      m.map((msg, i) => (i === index ? { ...msg, resolution: 'cancelled', resolutionMessage: 'Cancelled.' } : msg)),
    );
    // Best-effort — the local UI has already moved on regardless of whether
    // this succeeds; it just keeps the persisted Approval Inbox row (spec
    // §29) from sitting there as "pending" forever after being cancelled
    // right here in chat.
    if (action.id) {
      authHeader().then((headers) =>
        fetch(`${API}/api/ai/pending/${action.id}/reject`, { method: 'POST', headers, body: JSON.stringify({ slug }) }).catch(() => {}),
      );
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
              {m.profitCard && (
                <button
                  onClick={() => setDrilldownCard(m.profitCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">{m.profitCard.period}</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <div className="text-[10px] text-muted">Net sales</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.profitCard.net_sales_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">Gross profit</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.profitCard.gross_profit_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">Net profit</div>
                      <div className={`font-mono font-bold text-sm ${m.profitCard.net_profit_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {formatCents(m.profitCard.net_profit_cents)}
                      </div>
                    </div>
                  </div>
                </button>
              )}
              {m.orderCard && (
                <button
                  onClick={() => setOrderDrilldown(m.orderCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">Order #{m.orderCard.order_number}</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <div className="text-[10px] text-muted">Net sales</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.orderCard.net_sales_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">COGS</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.orderCard.cogs_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">Contribution</div>
                      <div className={`font-mono font-bold text-sm ${m.orderCard.contribution_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {formatCents(m.orderCard.contribution_cents)}
                      </div>
                    </div>
                  </div>
                </button>
              )}
              {m.dealCard && (
                <button
                  onClick={() => setDealDrilldown(m.dealCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">{m.dealCard.period} · {m.dealCard.deals.length} deal(s)</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="text-[11px] text-muted mt-1">
                    Top: {m.dealCard.deals.slice().sort((a, b) => b.contribution_cents - a.contribution_cents)[0]?.name}
                  </div>
                </button>
              )}
              {m.pendingAction && (
                <div className="mt-2 max-w-[85%] rounded-lg border border-primary/40 bg-primary/5 p-3 text-left">
                  <p className="text-xs font-semibold mb-2">{m.pendingAction.summary}</p>
                  {!m.resolution ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => confirmAction(i, m.pendingAction!)}
                        disabled={confirming === i}
                        className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        {confirming === i ? 'Working…' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => cancelAction(i, m.pendingAction!)}
                        disabled={confirming === i}
                        className="rounded border border-border px-3 py-1.5 text-xs font-semibold"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <p
                      className={`text-xs font-semibold ${
                        m.resolution === 'confirmed'
                          ? 'text-ok'
                          : m.resolution === 'failed'
                            ? 'text-danger'
                            : 'text-muted'
                      }`}
                    >
                      {m.resolutionMessage}
                    </p>
                  )}
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

      {drilldownCard && (
        <ProfitDrilldownModal
          profit={drilldownCard}
          from={new Date(drilldownCard.from_ts)}
          to={new Date(drilldownCard.to_ts)}
          periodLabel={drilldownCard.period}
          onClose={() => setDrilldownCard(null)}
        />
      )}
      {orderDrilldown && <OrderDrilldownModal order={orderDrilldown} onClose={() => setOrderDrilldown(null)} />}
      {dealDrilldown && (
        <DealDrilldownModal period={dealDrilldown.period} deals={dealDrilldown.deals} onClose={() => setDealDrilldown(null)} />
      )}
    </div>
  );
}
