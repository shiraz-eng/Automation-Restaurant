'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';

export type Closing = {
  business_date: string;
  status: string;
  opening_cash_cents: number;
  closing_cash_cents: number | null;
  expected_cash_cents: number | null;
  difference_cents: number | null;
  gross_sales_cents: number;
  discounts_cents: number;
  refunds_cents: number;
  net_sales_cents: number;
  order_count: number;
  closed_at: string | null;
  reopened_at: string | null;
  note: string | null;
};

const cents = (v: string) => Math.round(parseFloat(v || '0') * 100);
const today = () => new Date().toISOString().slice(0, 10);

export function DayCloseClient({
  closings,
  canClose,
  canReopen,
}: {
  closings: Closing[];
  canClose: boolean;
  canReopen: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [date, setDate] = useState(today());
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Closing | null>(null);

  async function closeDay() {
    setBusy(true);
    setError(null);
    setResult(null);
    const { data, error: e } = await supabase.rpc('close_business_day', {
      p_business_date: date,
      p_opening_cash: cents(opening),
      p_closing_cash: closing.trim() ? cents(closing) : null,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setResult((Array.isArray(data) ? data[0] : data) as Closing);
    router.refresh();
  }

  async function reopen(d: string) {
    const reason = window.prompt(`Reopen ${d}. Reason:`);
    if (!reason) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc('reopen_business_day', {
      p_business_date: d,
      p_reason: reason,
    });
    setBusy(false);
    if (e) setError(e.message);
    else router.refresh();
  }

  return (
    <div className="space-y-6">
      {canClose && (
        <Card>
          <h2 className="font-bold text-sm mb-3">Close a business day</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <Field label="Business date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Opening cash">
              <Input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} />
            </Field>
            <Field label="Counted cash">
              <Input type="number" step="0.01" value={closing} onChange={(e) => setClosing(e.target.value)} />
            </Field>
            <Button onClick={closeDay} disabled={busy}>
              {busy ? 'Closing…' : 'Close day'}
            </Button>
          </div>
          <Input
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-3"
          />
          {error && <p className="text-danger text-xs mt-2">{error}</p>}
          {result && (
            <div className="mt-3 rounded border border-border bg-main p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted">Net sales</span><span className="font-bold">{formatCents(result.net_sales_cents)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Orders</span><span>{result.order_count}</span></div>
              <div className="flex justify-between"><span className="text-muted">Expected cash</span><span>{formatCents(result.expected_cash_cents ?? 0)}</span></div>
              {result.difference_cents != null && (
                <div className="flex justify-between">
                  <span className="text-muted">Difference</span>
                  <span className={result.difference_cents < 0 ? 'text-danger font-bold' : 'text-ok font-bold'}>
                    {formatCents(result.difference_cents)}
                  </span>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Date</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3 font-semibold text-right">Net sales</th>
              <th className="p-3 font-semibold text-right">Difference</th>
              <th className="p-3 font-semibold" />
            </tr>
          </thead>
          <tbody>
            {closings.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-3 text-muted">No days closed yet.</td>
              </tr>
            ) : (
              closings.map((c) => (
                <tr key={c.business_date} className="border-b border-border/60 last:border-0">
                  <td className="p-3 font-semibold">{c.business_date}</td>
                  <td className="p-3">
                    <span className={c.status === 'closed' ? 'text-ok' : 'text-warn'}>{c.status}</span>
                  </td>
                  <td className="p-3 text-right">{formatCents(c.net_sales_cents)}</td>
                  <td className="p-3 text-right">
                    {c.difference_cents == null ? '—' : formatCents(c.difference_cents)}
                  </td>
                  <td className="p-3 text-right">
                    {canReopen && c.status === 'closed' && (
                      <button
                        onClick={() => reopen(c.business_date)}
                        disabled={busy}
                        className="text-primary underline"
                      >
                        reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
