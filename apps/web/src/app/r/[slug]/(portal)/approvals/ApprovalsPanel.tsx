'use client';

import { useEffect, useState, useCallback } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatDateTime } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type PendingItem = {
  id: string;
  action_name: string;
  args: Record<string, unknown>;
  summary: string;
  proposed_by_email: string | null;
  proposed_by_role: string | null;
  created_at: string;
};

export function ApprovalsPanel({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    </div>
  );
}
