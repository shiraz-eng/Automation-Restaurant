'use client';

import { useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';
import type { Period } from './PerformancePanel';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Captured verbatim from get_period_profitability's own tool result
// (routes/ai.ts) — never recomputed here. Same shape as AiChat.tsx's card.
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

const SUGGESTIONS = [
  'How is my restaurant performing?',
  "Show me this month's performance",
  'Which day had the highest sales?',
  'How is attendance this month?',
  'Show me my best-selling products',
];

// Deterministic period detection from the owner's own words — the visual
// panels above sync to whatever period they actually named, rather than
// leaving "which period did the model mean" to the model itself (spec §19:
// the visual result comes from the same authoritative charts already on
// the page, not a separate AI-drawn one).
const PERIOD_WORDS: { pattern: RegExp; period: Period }[] = [
  { pattern: /\byesterday\b/i, period: 'yesterday' },
  { pattern: /\blast week\b/i, period: 'last_week' },
  { pattern: /\bthis week\b/i, period: 'this_week' },
  { pattern: /\blast month\b/i, period: 'last_month' },
  { pattern: /\bthis month\b/i, period: 'this_month' },
  { pattern: /\btoday\b/i, period: 'today' },
];

export function AskAi({
  slug,
  onPeriodDetected,
  onReply,
}: {
  slug: string;
  onPeriodDetected?: (p: Period) => void;
  onReply?: (reply: string) => void;
}) {
  const supabase = usePortalSupabase();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profitCard, setProfitCard] = useState<ProfitCard | null>(null);
  const [drilldownOpen, setDrilldownOpen] = useState(false);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setReply(null);
    setProfitCard(null);
    for (const { pattern, period } of PERIOD_WORDS) {
      if (pattern.test(q)) {
        onPeriodDetected?.(period);
        break;
      }
    }
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ slug, messages: [{ role: 'user', content: q }] }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          body.error === 'ai_not_configured'
            ? 'The assistant is not configured.'
            : (body.message ?? body.error ?? 'The assistant failed.'),
        );
        return;
      }
      const replyText = body.reply ?? '(no answer)';
      setReply(replyText);
      setTools((body.tools ?? []).map((t: { name: string }) => t.name));
      setProfitCard(body.profitCard ?? null);
      onReply?.(replyText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <h3 className="font-bold text-sm mb-1">Ask AI about your restaurant</h3>
      <p className="text-muted text-[11px] mb-3">
        Reads live data with your permissions — it can&apos;t change anything from here. Naming a period (&quot;this
        month&quot;, &quot;yesterday&quot;…) syncs the charts above to match.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
          setInput('');
        }}
        className="flex gap-2 mb-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask AI about your restaurant…"
          className="flex-1 rounded border border-border bg-main px-3 py-2 text-xs outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-primary text-primary-fg px-4 py-2 text-xs font-semibold disabled:opacity-50 shrink-0"
        >
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            disabled={busy}
            className="text-[10px] px-2 py-1 rounded-full border border-border text-muted hover:text-body hover:border-primary transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
      {reply && (
        <div className="rounded border border-border bg-main p-3 text-xs whitespace-pre-wrap leading-relaxed">
          {reply}
          {tools.length > 0 && <p className="text-muted text-[10px] mt-2 not-italic">· {tools.join(' · ')}</p>}
        </div>
      )}
      {profitCard && (
        <button
          onClick={() => setDrilldownOpen(true)}
          className="mt-2 w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-2.5 text-left"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted font-semibold">{profitCard.period}</span>
            <span className="text-primary font-semibold">View breakdown →</span>
          </div>
          <div className="flex items-center gap-4 mt-1">
            <div>
              <div className="text-[10px] text-muted">Net sales</div>
              <div className="font-mono font-bold text-sm">{formatCents(profitCard.net_sales_cents)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted">Gross profit</div>
              <div className="font-mono font-bold text-sm">{formatCents(profitCard.gross_profit_cents)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted">Net profit</div>
              <div className={`font-mono font-bold text-sm ${profitCard.net_profit_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                {formatCents(profitCard.net_profit_cents)}
              </div>
            </div>
          </div>
        </button>
      )}

      {drilldownOpen && profitCard && (
        <ProfitDrilldownModal
          profit={profitCard}
          from={new Date(profitCard.from_ts)}
          to={new Date(profitCard.to_ts)}
          periodLabel={profitCard.period}
          onClose={() => setDrilldownOpen(false)}
        />
      )}
    </div>
  );
}
