'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatDateTime } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Mirrors GET /api/ai/export-history's row shape (export_audit_log,
// tenant-migrations/0037-0039) — this panel only lists what the server
// already wrote when each report/export actually ran; nothing is
// computed here.
type ExportRecord = {
  id: string;
  format: 'pdf' | 'excel';
  domain: string;
  period_label: string;
  period_from: string;
  period_to: string;
  sheets: string[] | null;
  storage_path: string | null;
  requested_by_email: string | null;
  requested_by_role: string | null;
  status: 'ready' | 'failed';
  error: string | null;
  created_at: string;
};

const FORMAT_LABEL: Record<string, string> = { pdf: 'PDF Report', excel: 'Excel Export' };
const DOMAIN_LABEL: Record<string, string> = {
  complete: 'Complete',
  suppliers: 'Suppliers',
  purchasing: 'Purchasing',
  inventory: 'Inventory',
  orders: 'Orders',
  expenses: 'Expenses',
};

export function ExportHistoryPanel({ slug }: { slug: string }) {
  const supabase = usePortalSupabase();
  const [items, setItems] = useState<ExportRecord[] | null>(null);
  const [migrated, setMigrated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleDownload(id: string) {
    setDownloadingId(id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/ai/export/download/${id}?slug=${encodeURIComponent(slug)}`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        setError(body.message ?? 'Could not re-download this report.');
        return;
      }
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch {
      setError('Network error.');
    } finally {
      setDownloadingId(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch(`${API}/api/ai/export-history?slug=${encodeURIComponent(slug)}`, {
          headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
        });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body.message ?? body.error ?? 'Could not load export history.');
          return;
        }
        setItems(body.items as ExportRecord[]);
        setMigrated(body.migrated !== false);
      } catch {
        if (!cancelled) setError('Network error.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, supabase]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-14 rounded-lg border border-border bg-surface animate-pulse" />
        ))}
      </div>
    );
  }
  if (error) return <p className="text-danger text-xs">{error}</p>;
  if (!migrated) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-xs text-muted">
        Export history isn&apos;t set up for this restaurant yet — it needs a one-time database update
        (tenant-migrations/0037-0039) before exports start being recorded here.
      </div>
    );
  }
  if (!items || items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface p-5 text-xs text-muted">
        No reports or exports generated yet. Use &quot;Generate Report&quot; or &quot;Export Excel&quot; on the
        Dashboard, or ask the AI Assistant.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <table className="w-full text-left text-xs">
        <thead className="text-muted bg-main">
          <tr className="border-b border-border">
            <th className="p-3 font-semibold">Report</th>
            <th className="p-3 font-semibold">Section</th>
            <th className="p-3 font-semibold">Period</th>
            <th className="p-3 font-semibold">Requested By</th>
            <th className="p-3 font-semibold">Generated At</th>
            <th className="p-3 font-semibold">Status</th>
            <th className="p-3 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} className="border-b border-border/60 last:border-0">
              <td className="p-3">
                <div className="font-semibold text-body">{FORMAT_LABEL[r.format] ?? r.format}</div>
                {r.sheets && r.sheets.length > 0 && (
                  <div className="text-[10px] text-muted mt-0.5">{r.sheets.join(', ')}</div>
                )}
              </td>
              <td className="p-3 text-muted">{DOMAIN_LABEL[r.domain] ?? r.domain}</td>
              <td className="p-3 text-muted">{r.period_label}</td>
              <td className="p-3">
                <div className="text-body">{r.requested_by_email ?? '—'}</div>
                {r.requested_by_role && <div className="text-[10px] text-muted capitalize">{r.requested_by_role}</div>}
              </td>
              <td className="p-3 text-muted">{formatDateTime(r.created_at)}</td>
              <td className="p-3">
                {r.status === 'ready' ? (
                  <span className="text-ok font-semibold">Ready</span>
                ) : (
                  <span className="text-danger font-semibold" title={r.error ?? undefined}>
                    Failed
                  </span>
                )}
              </td>
              <td className="p-3 text-right">
                {r.storage_path ? (
                  <button
                    onClick={() => handleDownload(r.id)}
                    disabled={downloadingId === r.id}
                    className="text-primary font-semibold hover:underline disabled:opacity-50"
                  >
                    {downloadingId === r.id ? 'Opening…' : 'Download'}
                  </button>
                ) : (
                  <span className="text-muted" title="This report wasn't permanently saved — regenerate it from the source page instead.">
                    —
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
