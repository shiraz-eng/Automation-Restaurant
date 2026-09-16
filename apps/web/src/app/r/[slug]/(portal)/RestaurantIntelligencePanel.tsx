'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
import type { Period } from './PerformancePanel';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type ScorecardRow = { domain: string; status: 'Healthy' | 'Stable' | 'Watch' | 'Needs Attention'; evidence: string[] };
type AttentionItem = { severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; category: string; message: string; open_in: string };
type AreaToReview = { area: string; evidence: string; recommendation: string };
type ExecutiveSummary = {
  purchasing_cents: number;
  supplier_payments_cents: number;
  outstanding_payables_cents: number;
  waste_cents: number;
} | { note: string };

// Captured verbatim from analyze_restaurant's own tool result (GET
// /api/ai/intelligence -> AI_TOOLS analyze_restaurant.run()) — the exact
// same call the AI chat's "Analyze my restaurant" answers with. This panel
// only lays it out; nothing here is recomputed (spec §25's dashboard
// layout request).
type Intelligence = {
  period: string;
  overall_status: 'Healthy' | 'Watch' | 'Needs Attention';
  executive_summary: ExecutiveSummary;
  scorecard: ScorecardRow[];
  attention_items: AttentionItem[];
  positive_highlights: string[];
  areas_to_review: AreaToReview[];
};

const STATUS_TONE: Record<string, string> = {
  Healthy: 'border-ok/40 bg-ok/10 text-ok',
  Stable: 'border-border bg-main text-muted',
  Watch: 'border-warn/40 bg-warn/10 text-warn',
  'Needs Attention': 'border-danger/40 bg-danger/10 text-danger',
};
const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: 'text-danger',
  HIGH: 'text-danger',
  MEDIUM: 'text-warn',
  LOW: 'text-muted',
};

export function RestaurantIntelligencePanel({ period }: { period: Period }) {
  const supabase = usePortalSupabase();
  const [data, setData] = useState<Intelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/intelligence?period=${period}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      if (cancelled) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? 'Could not load restaurant intelligence.');
        setLoading(false);
        return;
      }
      const body = (await res.json()) as Intelligence;
      setData(body);
      setLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setError('Network error.');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, period]);

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-surface p-5">
        <div className="h-5 w-48 rounded bg-main animate-pulse mb-4" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg border border-border bg-main animate-pulse" />
          ))}
        </div>
      </section>
    );
  }
  if (error || !data) {
    return (
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-bold mb-1">Restaurant Intelligence</h2>
        <p className="text-danger text-xs">{error ?? 'No data available.'}</p>
      </section>
    );
  }

  const exec = 'note' in data.executive_summary ? null : data.executive_summary;
  const topAttention = data.attention_items.slice(0, expanded ? undefined : 4);
  const topPositives = data.positive_highlights.slice(0, expanded ? undefined : 4);
  const topAreas = data.areas_to_review.slice(0, expanded ? undefined : 3);

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-bold">Restaurant Intelligence</h2>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[data.overall_status]}`}>
            {data.overall_status}
          </span>
        </div>
        <span className="text-muted text-[11px]">{data.period}</span>
      </div>

      {exec && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MiniStat label="Purchasing" value={formatCents(exec.purchasing_cents)} />
          <MiniStat label="Supplier Payments" value={formatCents(exec.supplier_payments_cents)} />
          <MiniStat
            label="Outstanding Payables"
            value={formatCents(exec.outstanding_payables_cents)}
            tone={exec.outstanding_payables_cents > 0 ? 'warn' : undefined}
          />
          <MiniStat label="Waste" value={formatCents(exec.waste_cents)} tone={exec.waste_cents > 0 ? 'warn' : undefined} />
        </div>
      )}

      <div>
        <h3 className="text-[11px] font-bold text-muted uppercase tracking-wide mb-2">Owner Scorecard</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {data.scorecard.map((row) => (
            <div key={row.domain} className={`rounded-lg border p-2.5 ${STATUS_TONE[row.status]}`} title={row.evidence.join(' ')}>
              <div className="text-[11px] font-bold">{row.domain}</div>
              <div className="text-[10px] opacity-80">{row.status}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div>
          <h3 className="text-[11px] font-bold text-muted uppercase tracking-wide mb-2">What needs attention</h3>
          {topAttention.length === 0 ? (
            <p className="text-ok text-xs">Nothing needs attention right now.</p>
          ) : (
            <ul className="space-y-2">
              {topAttention.map((item, i) => (
                <li key={i} className="text-xs leading-snug">
                  <span className={`font-bold ${SEVERITY_TONE[item.severity]}`}>{item.severity}</span>{' '}
                  <span className="text-body">{item.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-[11px] font-bold text-muted uppercase tracking-wide mb-2">What&apos;s working</h3>
          {topPositives.length === 0 ? (
            <p className="text-muted text-xs">No clear period-over-period improvements found yet.</p>
          ) : (
            <ul className="space-y-2">
              {topPositives.map((h, i) => (
                <li key={i} className="text-xs leading-snug flex gap-1.5">
                  <span className="text-ok font-bold">✓</span>
                  <span className="text-body">{h}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-[11px] font-bold text-muted uppercase tracking-wide mb-2">Areas to review</h3>
          {topAreas.length === 0 ? (
            <p className="text-muted text-xs">No notable concerns found in this period.</p>
          ) : (
            <ul className="space-y-2.5">
              {topAreas.map((a, i) => (
                <li key={i} className="text-xs leading-snug">
                  <div className="font-semibold text-body">{a.area}</div>
                  <div className="text-muted">{a.evidence}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {(data.attention_items.length > 4 || data.positive_highlights.length > 4 || data.areas_to_review.length > 3) && (
        <button onClick={() => setExpanded((v) => !v)} className="text-primary text-[11px] font-semibold hover:underline">
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border border-border bg-main p-3">
      <div className="text-[10px] text-muted">{label}</div>
      <div className={`mt-0.5 font-bold text-sm tabular-nums ${tone === 'warn' ? 'text-warn' : 'text-body'}`}>{value}</div>
    </div>
  );
}
