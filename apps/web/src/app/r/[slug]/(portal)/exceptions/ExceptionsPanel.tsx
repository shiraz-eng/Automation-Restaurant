'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type StateStatus = 'acknowledged' | 'resolved' | 'ignored';
type ExceptionState = { status: StateStatus; note: string | null; actor_email: string | null; updated_at: string } | null;
type AttentionItem = { severity: Severity; category: string; message: string; open_in: string; state: ExceptionState };

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

const STATE_LABEL: Record<StateStatus, string> = { acknowledged: 'Acknowledged', resolved: 'Resolved', ignored: 'Ignored' };

export function ExceptionsPanel({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showHandled, setShowHandled] = useState(false);

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
      const res = await fetch(`${API}/api/ai/attention?slug=${encodeURIComponent(slug)}`, { headers: await authHeader() });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function setState(item: AttentionItem, status: StateStatus) {
    const key = `${item.category}::${item.message}`;
    setBusyKey(key);
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/attention/state`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, category: item.category, message: item.message, status }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not update that.');
        return;
      }
      // Update locally rather than a full reload — the exception itself
      // (severity/message) is unchanged, only its state is.
      setItems((cur) => (cur ?? []).map((x) => (x === item ? { ...x, state: { status, note: null, actor_email: null, updated_at: new Date().toISOString() } } : x)));
    } catch {
      setError('Network error.');
    } finally {
      setBusyKey(null);
    }
  }

  const visibleItems = (items ?? []).filter((i) => showHandled || !i.state || i.state.status === 'acknowledged');
  const handledCount = (items ?? []).filter((i) => i.state && i.state.status !== 'acknowledged').length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-muted">{items ? `${visibleItems.length} item${visibleItems.length === 1 ? '' : 's'}` : loading ? 'Loading…' : ''}</div>
        <div className="flex items-center gap-2">
          {handledCount > 0 && (
            <button onClick={() => setShowHandled((v) => !v)} className="text-xs font-semibold text-muted underline">
              {showHandled ? 'Hide' : 'Show'} {handledCount} resolved/ignored
            </button>
          )}
          <button onClick={load} disabled={loading} className="text-xs font-semibold rounded border border-border px-2.5 py-1 disabled:opacity-50">
            {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {!error && items && visibleItems.length === 0 && (
        <div className="rounded-lg border border-ok/40 bg-ok/10 p-4 text-sm text-ok font-semibold">
          Nothing needs attention right now.
        </div>
      )}

      {visibleItems.length > 0 && (
        <div className="space-y-2">
          {visibleItems.map((item, i) => {
            const route = OPEN_IN_ROUTE[item.open_in];
            const key = `${item.category}::${item.message}`;
            const busy = busyKey === key;
            return (
              <div key={i} className={`rounded-lg border p-3 text-sm space-y-2 ${SEVERITY_STYLE[item.severity]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-wide">{item.severity}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted">· {item.category}</span>
                      {item.state && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted">
                          · {STATE_LABEL[item.state.status]}
                          {item.state.actor_email ? ` by ${item.state.actor_email}` : ''}
                        </span>
                      )}
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
                <div className="flex gap-2">
                  <button
                    onClick={() => setState(item, 'acknowledged')}
                    disabled={busy || item.state?.status === 'acknowledged'}
                    className="text-[11px] font-semibold rounded border border-border px-2 py-1 disabled:opacity-40"
                  >
                    Acknowledge
                  </button>
                  <button
                    onClick={() => setState(item, 'resolved')}
                    disabled={busy || item.state?.status === 'resolved'}
                    className="text-[11px] font-semibold rounded border border-ok text-ok px-2 py-1 disabled:opacity-40"
                  >
                    Mark resolved
                  </button>
                  <button
                    onClick={() => setState(item, 'ignored')}
                    disabled={busy || item.state?.status === 'ignored'}
                    className="text-[11px] font-semibold rounded border border-border text-muted px-2 py-1 disabled:opacity-40"
                  >
                    Ignore
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
