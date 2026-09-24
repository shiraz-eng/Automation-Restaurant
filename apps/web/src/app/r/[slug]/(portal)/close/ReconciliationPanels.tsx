'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type MethodRow = {
  method: string;
  payment_count: number;
  captured_cents: number;
  refunded_cents: number;
  net_cents: number;
  reconciled_count: number;
  unreconciled_count: number;
};

/**
 * payments.reconcile — match each payment method's takings for a day
 * against the bank/card statement and mark them reconciled. Reconciled
 * payments can no longer be corrected with adjust_payment().
 */
export function PaymentReconciliationPanel() {
  const supabase = usePortalSupabase();
  const [date, setDate] = useState(todayIso());
  const [rows, setRows] = useState<MethodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: e } = await supabase.rpc('payment_reconciliation', { p_date: date });
    if (e) setError(e.message);
    else setRows((data ?? []) as MethodRow[]);
    setLoading(false);
  }, [supabase, date]);

  useEffect(() => {
    void load();
  }, [load]);

  async function reconcile(method: string) {
    setBusy(method);
    setError(null);
    setNote(null);
    const { data, error: e } = await supabase.rpc('reconcile_payments', { p_date: date, p_method: method });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setNote(`Marked ${data ?? 0} ${method} payment(s) reconciled.`);
    await load();
  }

  const total = rows.reduce((s, r) => s + Number(r.net_cents), 0);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-wrap items-end justify-between gap-3 p-3 border-b border-border">
        <div>
          <h3 className="font-bold text-sm">Payment reconciliation</h3>
          <p className="text-muted text-[11px]">Check each method&rsquo;s takings against your statement, then mark them reconciled.</p>
        </div>
        <Field label="Business day">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        </Field>
      </div>
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      {note && <div className="bg-ok/10 text-ok text-xs p-3">{note}</div>}
      {loading ? (
        <p className="p-3 text-muted text-xs">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-3 text-muted text-xs">No payments on this day.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="p-2.5 font-semibold">Method</th>
                <th className="p-2.5 font-semibold text-right">Payments</th>
                <th className="p-2.5 font-semibold text-right">Taken</th>
                <th className="p-2.5 font-semibold text-right">Refunded</th>
                <th className="p-2.5 font-semibold text-right">Net</th>
                <th className="p-2.5 font-semibold">Status</th>
                <th className="p-2.5" />
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.method} className="border-b border-border/60 last:border-0">
                  <td className="p-2.5 font-semibold capitalize">{r.method}</td>
                  <td className="p-2.5 text-right">{r.payment_count}</td>
                  <td className="p-2.5 text-right">{formatCents(Number(r.captured_cents))}</td>
                  <td className="p-2.5 text-right text-warn">{Number(r.refunded_cents) ? `−${formatCents(Number(r.refunded_cents))}` : '—'}</td>
                  <td className="p-2.5 text-right font-bold">{formatCents(Number(r.net_cents))}</td>
                  <td className="p-2.5">
                    {Number(r.unreconciled_count) === 0 ? (
                      <span className="text-ok">reconciled</span>
                    ) : (
                      <span className="text-warn">{r.unreconciled_count} open</span>
                    )}
                  </td>
                  <td className="p-2.5 text-right">
                    {Number(r.unreconciled_count) > 0 && (
                      <Button disabled={busy === r.method} onClick={() => reconcile(r.method)}>
                        Mark reconciled
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-border font-bold">
                <td className="p-2.5" colSpan={4}>
                  Total
                </td>
                <td className="p-2.5 text-right">{formatCents(total)}</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type CashCount = {
  id: string;
  business_date: string;
  opening_cents: number;
  counted_cents: number;
  expected_cents: number;
  difference_cents: number;
  note: string | null;
  counted_by_email: string | null;
  created_at: string;
};

/**
 * finance.reconcile — count the cash drawer at any point in the day and see
 * it against opening float + cash taken (record_cash_count). Separate from
 * closing the day, so a shift change or mid-day count doesn't need
 * finance.close_day.
 */
export function CashCountPanel() {
  const supabase = usePortalSupabase();
  const [date, setDate] = useState(todayIso());
  const [opening, setOpening] = useState('');
  const [counted, setCounted] = useState('');
  const [countNote, setCountNote] = useState('');
  const [rows, setRows] = useState<CashCount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('cash_counts')
      .select('id, business_date, opening_cents, counted_cents, expected_cents, difference_cents, note, counted_by_email, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (e) setError(e.message);
    else setRows((data ?? []) as CashCount[]);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const c = Math.round(parseFloat(counted) * 100);
    const o = opening.trim() ? Math.round(parseFloat(opening) * 100) : 0;
    if (!Number.isFinite(c) || c < 0 || !Number.isFinite(o) || o < 0) {
      setError('Enter the cash counted (and opening float, if any).');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('record_cash_count', {
      p_business_date: date,
      p_opening_cents: o,
      p_counted_cents: c,
      p_note: countNote.trim() || null,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setCounted('');
    setCountNote('');
    await load();
  }

  return (
    <Card>
      <h3 className="font-bold text-sm">Cash count</h3>
      <p className="text-muted text-[11px] mb-3">Count the drawer — the difference is against opening float plus cash taken that day.</p>
      <form onSubmit={submit} className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
        <Field label="Business day">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Opening float">
          <Input type="number" step="0.01" min="0" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
        </Field>
        <Field label="Cash counted">
          <Input type="number" step="0.01" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={countNote} onChange={(e) => setCountNote(e.target.value)} placeholder="Shift change" />
        </Field>
        <Button type="submit" disabled={busy || !counted.trim()}>
          Record count
        </Button>
      </form>
      {error && <p className="text-danger text-xs mt-2">{error}</p>}
      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="py-2 font-semibold">Counted at</th>
                <th className="py-2 font-semibold text-right">Expected</th>
                <th className="py-2 font-semibold text-right">Counted</th>
                <th className="py-2 font-semibold text-right">Difference</th>
                <th className="py-2 font-semibold pl-3">By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2">
                    {formatDateTime(r.created_at)}
                    {r.note ? <span className="text-muted"> · {r.note}</span> : null}
                  </td>
                  <td className="py-2 text-right">{formatCents(r.expected_cents)}</td>
                  <td className="py-2 text-right">{formatCents(r.counted_cents)}</td>
                  <td
                    className={`py-2 text-right font-bold ${
                      r.difference_cents === 0 ? 'text-ok' : r.difference_cents < 0 ? 'text-danger' : 'text-warn'
                    }`}
                  >
                    {r.difference_cents > 0 ? '+' : ''}
                    {formatCents(r.difference_cents)}
                  </td>
                  <td className="py-2 pl-3 text-muted">{r.counted_by_email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
