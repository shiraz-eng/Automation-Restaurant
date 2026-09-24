'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Select } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

type Review = {
  id: string;
  table_label: string | null;
  guest_name: string | null;
  overall: number;
  food: number | null;
  service: number | null;
  cleanliness: number | null;
  speed: number | null;
  ambiance: number | null;
  comment: string | null;
  created_at: string;
  response: string | null;
  responded_at: string | null;
  responded_by: string | null;
  is_hidden: boolean;
  moderation_note: string | null;
};

type Analytics = {
  count: number;
  avg_overall: number | null;
  avg_food: number | null;
  avg_service: number | null;
  avg_cleanliness: number | null;
  avg_speed: number | null;
  avg_ambiance: number | null;
  responded: number;
  by_star: Record<string, number>;
  by_week: { week: string; count: number; avg: number }[];
};

const RANGES = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

function Stars({ n }: { n: number }) {
  return (
    <span className="text-warn tracking-tight" aria-label={`${n} out of 5`}>
      {'★'.repeat(n)}
      <span className="text-border">{'★'.repeat(5 - n)}</span>
    </span>
  );
}

/**
 * Guest feedback from the QR order-tracking page. reviews.view lists it
 * (feedback's RLS read key), reviews.analytics adds the rating breakdown
 * (review_analytics), reviews.respond lets staff reply (respond_to_review)
 * and reviews.moderate hides abusive/irrelevant entries from the numbers
 * (moderate_review). Every write is an RPC that checks its own key.
 */
export function ReviewsManager({
  canAnalytics,
  canRespond,
  canModerate,
}: {
  canAnalytics: boolean;
  canRespond: boolean;
  canModerate: boolean;
}) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<Review[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [range, setRange] = useState(30);
  const [filter, setFilter] = useState<'all' | 'low' | 'unanswered' | 'hidden'>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - range * 86400000).toISOString();
    const [list, stats] = await Promise.all([
      supabase
        .from('feedback')
        .select(
          'id, table_label, guest_name, overall, food, service, cleanliness, speed, ambiance, comment, created_at, response, responded_at, responded_by, is_hidden, moderation_note',
        )
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(300),
      canAnalytics
        ? supabase.rpc('review_analytics', { p_from: since, p_to: new Date().toISOString() })
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (list.error) setError(list.error.message);
    setRows((list.data ?? []) as Review[]);
    setAnalytics((stats.data as Analytics | null) ?? null);
    setLoading(false);
  }, [supabase, range, canAnalytics]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () =>
      rows.filter((r) => {
        if (filter === 'hidden') return r.is_hidden;
        if (r.is_hidden && !canModerate) return false;
        if (filter === 'low') return r.overall <= 2;
        if (filter === 'unanswered') return !r.response;
        return true;
      }),
    [rows, filter, canModerate],
  );

  async function act(id: string, fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusyId(id);
    setError(null);
    const { error: e } = await fn();
    setBusyId(null);
    if (e) {
      setError(e.message);
      return false;
    }
    await load();
    return true;
  }

  async function respond(r: Review) {
    const text = (drafts[r.id] ?? '').trim();
    if (!text) return;
    const ok = await act(r.id, () => supabase.rpc('respond_to_review', { p_feedback_id: r.id, p_response: text }));
    if (ok) setDrafts((d) => ({ ...d, [r.id]: '' }));
  }

  function moderate(r: Review) {
    const hide = !r.is_hidden;
    const reason = hide ? window.prompt('Why hide this review? (kept for the audit log)') : '';
    if (hide && reason == null) return;
    void act(r.id, () => supabase.rpc('moderate_review', { p_feedback_id: r.id, p_hidden: hide, p_note: reason || null }));
  }

  const categories: [string, number | null][] = analytics
    ? [
        ['Food', analytics.avg_food],
        ['Service', analytics.avg_service],
        ['Cleanliness', analytics.avg_cleanliness],
        ['Speed', analytics.avg_speed],
        ['Ambiance', analytics.avg_ambiance],
      ]
    : [];
  const maxStar = analytics ? Math.max(1, ...Object.values(analytics.by_star ?? {}).map(Number)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(range)} onChange={(e) => setRange(Number(e.target.value))} className="w-40">
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="w-44">
          <option value="all">All reviews</option>
          <option value="low">1–2 stars</option>
          <option value="unanswered">Not answered yet</option>
          {canModerate && <option value="hidden">Hidden</option>}
        </Select>
      </div>

      {canAnalytics && analytics && (
        <Card>
          <div className="flex flex-wrap gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted font-bold">Average rating</div>
              <div className="text-3xl font-black tabular-nums">{analytics.avg_overall ?? '—'}</div>
              <div className="text-muted text-[11px]">
                {analytics.count} reviews · {analytics.responded} answered
              </div>
            </div>
            <div className="min-w-[180px] flex-1 space-y-1">
              {[5, 4, 3, 2, 1].map((star) => {
                const n = Number(analytics.by_star?.[String(star)] ?? 0);
                return (
                  <div key={star} className="flex items-center gap-2 text-[11px]">
                    <span className="w-6 text-muted">{star}★</span>
                    <div className="h-2 flex-1 rounded bg-main overflow-hidden">
                      <div className="h-full bg-warn" style={{ width: `${(n / maxStar) * 100}%` }} />
                    </div>
                    <span className="w-8 text-right tabular-nums text-muted">{n}</span>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] self-center">
              {categories.map(([label, v]) => (
                <div key={label} className="flex justify-between gap-3">
                  <span className="text-muted">{label}</span>
                  <span className="font-bold tabular-nums">{v ?? '—'}</span>
                </div>
              ))}
            </div>
          </div>
          {analytics.by_week.length > 1 && (
            <div className="mt-4 flex items-end gap-1 h-16" aria-label="Average rating by week">
              {analytics.by_week.map((w) => (
                <div key={w.week} className="flex-1 flex flex-col items-center gap-0.5" title={`${w.week}: ${w.avg} (${w.count})`}>
                  <div className="w-full rounded-t bg-primary/70" style={{ height: `${(Number(w.avg) / 5) * 100}%` }} />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      {loading ? (
        <Card className="text-muted text-xs">Loading…</Card>
      ) : shown.length === 0 ? (
        <Card className="text-muted text-xs">No reviews in this range.</Card>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            <Card key={r.id} className={r.is_hidden ? 'opacity-60' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <Stars n={r.overall} />
                  <span className="ml-2 text-xs font-semibold">{r.guest_name || 'Guest'}</span>
                  <span className="ml-2 text-[11px] text-muted">
                    {r.table_label ? `${r.table_label} · ` : ''}
                    {formatDateTime(r.created_at)}
                  </span>
                  {r.is_hidden && <span className="ml-2 text-[10px] font-bold text-danger uppercase">hidden</span>}
                </div>
                {canModerate && (
                  <Button variant="ghost" disabled={busyId === r.id} onClick={() => moderate(r)}>
                    {r.is_hidden ? 'Restore' : 'Hide'}
                  </Button>
                )}
              </div>
              {r.comment && <p className="text-xs mt-2 whitespace-pre-wrap">{r.comment}</p>}
              {r.moderation_note && r.is_hidden && <p className="text-[11px] text-muted mt-1">Hidden: {r.moderation_note}</p>}
              {r.response && (
                <div className="mt-2 rounded-md border border-border bg-main/50 p-2 text-xs">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wide mb-0.5">
                    Reply{r.responded_by ? ` · ${r.responded_by}` : ''}
                  </div>
                  {r.response}
                </div>
              )}
              {canRespond && (
                <div className="mt-2 flex gap-2">
                  <textarea
                    value={drafts[r.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    placeholder={r.response ? 'Update your reply…' : 'Write a reply…'}
                    rows={2}
                    className="flex-1 rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                  />
                  <Button disabled={busyId === r.id || !(drafts[r.id] ?? '').trim()} onClick={() => respond(r)}>
                    {r.response ? 'Update' : 'Reply'}
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
