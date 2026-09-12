'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type AttentionItem = { severity: Severity; category: string; message: string; open_in: string };

// Maps an item's open_in label to a real portal route — only for labels
// that actually have a page; anything else renders as plain text rather
// than a broken link (never invent a route that doesn't exist).
const OPEN_IN_ROUTE: Record<string, string> = {
  Inventory: 'inventory',
  Purchasing: 'purchasing',
  Kitchen: 'kds',
  Team: 'scheduling',
  Recipes: 'recipes',
};

const SEVERITY_STYLE: Record<Severity, string> = {
  CRITICAL: 'border-danger bg-danger/10 text-danger',
  HIGH: 'border-danger/50 bg-danger/5 text-danger',
  MEDIUM: 'border-warn/50 bg-warn/5 text-warn',
  LOW: 'border-border bg-surface text-muted',
};

export function ExceptionsPanel({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/attention?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not load exceptions.');
        return;
      }
      setItems(body.items as AttentionItem[]);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, [slug, supabase]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">{items ? `${items.length} item${items.length === 1 ? '' : 's'}` : loading ? 'Loading…' : ''}</div>
        <button onClick={load} disabled={loading} className="text-xs font-semibold rounded border border-border px-2.5 py-1 disabled:opacity-50">
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {!error && items && items.length === 0 && (
        <div className="rounded-lg border border-ok/40 bg-ok/10 p-4 text-sm text-ok font-semibold">
          Nothing needs attention right now.
        </div>
      )}

      {items && items.length > 0 && (
        <div className="space-y-2">
          {items.map((item, i) => {
            const route = OPEN_IN_ROUTE[item.open_in];
            return (
              <div key={i} className={`rounded-lg border p-3 text-sm flex items-start justify-between gap-3 ${SEVERITY_STYLE[item.severity]}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-wide">{item.severity}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted">· {item.category}</span>
                  </div>
                  <p>{item.message}</p>
                </div>
                {route ? (
                  <Link href={`/r/${slug}/${route}`} className="shrink-0 text-xs font-bold rounded bg-primary text-primary-fg px-2.5 py-1.5 whitespace-nowrap">
                    Open {item.open_in}
                  </Link>
                ) : (
                  <span className="shrink-0 text-xs text-muted whitespace-nowrap">{item.open_in}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
