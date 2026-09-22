'use client';

import { useEffect, useState } from 'react';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { AdminCard } from '../_components/ui';
import { formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Invoice = {
  id: string;
  customer: string | null;
  status: string | null;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  created: number;
  hosted_invoice_url: string | null;
};

export function InvoicesClient() {
  const supabase = createControlPlaneBrowserClient();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/admin/invoices`, {
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      });
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(body.message ?? 'Could not load invoices.');
        setInvoices([]);
        return;
      }
      setInvoices(body.invoices ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (error) {
    return (
      <AdminCard>
        <p className="text-red-400 text-xs">{error}</p>
      </AdminCard>
    );
  }

  return (
    <AdminCard className="overflow-x-auto">
      {invoices === null ? (
        <p className="text-ink-muted text-xs">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="text-ink-muted text-xs">No invoices yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-ink-muted">
            <tr className="border-b border-white/10">
              <th className="pb-2 font-semibold">Date</th>
              <th className="pb-2 font-semibold">Status</th>
              <th className="pb-2 font-semibold text-right">Amount paid</th>
              <th className="pb-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} className="border-b border-white/10 last:border-0">
                <td className="py-2 text-ink-muted">{new Date(inv.created * 1000).toLocaleDateString()}</td>
                <td className="py-2 font-semibold capitalize">{inv.status}</td>
                <td className="py-2 text-right font-bold">{formatCents(inv.amount_paid_cents)}</td>
                <td className="py-2 text-right">
                  {inv.hosted_invoice_url && (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-gold hover:underline">
                      View
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AdminCard>
  );
}
