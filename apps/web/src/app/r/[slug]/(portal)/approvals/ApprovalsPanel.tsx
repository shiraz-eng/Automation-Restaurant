'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatDateTime, formatCents } from '@/lib/format';
import { ProfitDrilldownModal } from '@/components/ProfitDrilldown';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// The exact period_profitability() row, captured server-side (routes/ai.ts's
// GET /pending) for a pending generate_report proposal specifically — never
// recomputed here, so an approver drilling in sees precisely what the
// report they're about to approve would actually contain.
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

type PendingItem = {
  id: string;
  action_name: string;
  args: Record<string, unknown>;
  summary: string;
  proposed_by_email: string | null;
  proposed_by_role: string | null;
  created_at: string;
  profitCard?: ProfitCard;
};

export function ApprovalsPanel({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drilldownCard, setDrilldownCard] = useState<ProfitCard | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/pending?slug=${encodeURIComponent(slug)}`, { headers: await authHeader() });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not load approvals.');
        return;
      }
      setItems(body.items as PendingItem[]);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(item: PendingItem) {
    setBusyId(item.id);
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/confirm`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, name: item.action_name, args: item.args, pendingActionId: item.id }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not approve that.');
        return;
      }
      // generate_report doesn't mutate anything — its result IS the report
      // data, turned into a real PDF client-side here (same generateReportPdf()
      // the Dashboard's own button and AiChat.tsx's inline confirm both use).
      if (item.action_name === 'generate_report' && body.result) {
        try {
          const { generateReportPdf } = await import('@/lib/generateReport');
          generateReportPdf(body.result);
        } catch (err) {
          console.error('PDF generation failed:', err);
        }
      }
      // export_excel_report only validates the range (see AiChat.tsx's
      // identical comment for why) — the actual .xlsx is fetched and
      // downloaded here once approved.
      if (item.action_name === 'export_excel_report' && body.result?.ready) {
        try {
          const r = body.result as { from: string; to: string; sheets?: string[] };
          const qs = new URLSearchParams({ slug, from: r.from, to: r.to, ...(r.sheets && r.sheets.length > 0 ? { sheets: r.sheets.join(',') } : {}) });
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
      setItems((cur) => (cur ?? []).filter((x) => x.id !== item.id));
    } catch {
      setError('Network error.');
    } finally {
      setBusyId(null);
    }
  }

  async function reject(item: PendingItem) {
    setBusyId(item.id);
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/pending/${item.id}/reject`, { method: 'POST', headers: await authHeader(), body: JSON.stringify({ slug }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not reject that.');
        return;
      }
      setItems((cur) => (cur ?? []).filter((x) => x.id !== item.id));
    } catch {
      setError('Network error.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">{items ? `${items.length} pending` : loading ? 'Loading…' : ''}</div>
        <button onClick={load} disabled={loading} className="text-xs font-semibold rounded border border-border px-2.5 py-1 disabled:opacity-50">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {!error && items && items.length === 0 && (
        <div className="rounded-lg border border-ok/40 bg-ok/10 p-4 text-sm text-ok font-semibold">Nothing waiting on approval.</div>
      )}

      {items && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm space-y-2">
              <div className="flex items-center gap-1.5 flex-wrap text-[10px] uppercase tracking-wide text-muted">
                <span className="font-bold text-primary">{item.action_name.replace(/_/g, ' ')}</span>
                <span>· proposed {formatDateTime(item.created_at)}</span>
                {item.proposed_by_email && <span>· by {item.proposed_by_email}</span>}
              </div>
              <p>{item.summary}</p>
              {item.profitCard && (
                <button
                  onClick={() => setDrilldownCard(item.profitCard!)}
                  className="w-full block rounded-lg border border-primary/40 bg-main hover:border-primary p-2.5 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">{item.profitCard.period}</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <div className="text-[10px] text-muted">Net sales</div>
                      <div className="font-mono font-bold text-sm">{formatCents(item.profitCard.net_sales_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">Gross profit</div>
                      <div className="font-mono font-bold text-sm">{formatCents(item.profitCard.gross_profit_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted">Net profit</div>
                      <div className={`font-mono font-bold text-sm ${item.profitCard.net_profit_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {formatCents(item.profitCard.net_profit_cents)}
                      </div>
                    </div>
                  </div>
                </button>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => approve(item)}
                  disabled={busyId === item.id}
                  className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {busyId === item.id ? 'Working…' : 'Approve'}
                </button>
                <button
                  onClick={() => reject(item)}
                  disabled={busyId === item.id}
                  className="rounded border border-danger text-danger font-semibold px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {drilldownCard && (
        <ProfitDrilldownModal
          profit={drilldownCard}
          from={new Date(drilldownCard.from_ts)}
          to={new Date(drilldownCard.to_ts)}
          periodLabel={drilldownCard.period}
          onClose={() => setDrilldownCard(null)}
        />
      )}
    </div>
  );
}
