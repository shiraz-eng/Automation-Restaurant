'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';

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

type Preview = {
  business_date: string;
  status: 'open' | 'closed';
  is_future: boolean;
  sales: {
    gross_sales_cents: number;
    discounts_cents: number;
    refunds_cents: number;
    net_sales_cents: number;
    order_count: number;
    tax_cents: number;
  };
  payments_by_method: Record<string, number>;
  cash: {
    opening_cents: number;
    cash_sales_cents: number;
    movements_cents: number;
    expected_cents: number;
    last_count: { counted_cents: number; difference_cents: number; created_at: string } | null;
  };
  expenses: { count: number; cents: number };
  supplier_payments: { count: number; cents: number };
  exceptions: {
    open_orders: number;
    unpaid_served_orders: { count: number; cents: number };
    expenses_awaiting_approval: number;
    invoice_holds_open: number;
  };
};

type Movement = { id: string; kind: string; signed_cents: number; reason: string; reference: string | null; created_at: string };

const KIND_LABEL: Record<string, string> = {
  pay_in: 'Pay-in',
  pay_out: 'Pay-out',
  bank_drop: 'Bank drop',
  adjustment: 'Adjustment',
};
const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  digital_wallet: 'Digital wallet',
  online: 'Online',
  other: 'Other',
};

const cents = (v: string) => Math.round((parseFloat(v || '0') || 0) * 100);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function DayCloseClient({
  closings,
  canClose,
  canReopen,
  canManageCash = false,
}: {
  closings: Closing[];
  canClose: boolean;
  canReopen: boolean;
  /** cash.manage / finance.reconcile — record pay-ins, pay-outs and bank drops. */
  canManageCash?: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [date, setDate] = useState(localToday());
  const [opening, setOpening] = useState('');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [mvKind, setMvKind] = useState('pay_out');
  const [mvAmount, setMvAmount] = useState('');
  const [mvReason, setMvReason] = useState('');
  const [mvRef, setMvRef] = useState('');

  const load = useCallback(async () => {
    const [p, m] = await Promise.all([
      supabase.rpc('day_close_preview', { p_business_date: date, p_opening_cents: cents(opening) }),
      supabase
        .from('cash_movements')
        .select('id, kind, signed_cents, reason, reference, created_at')
        .eq('business_date', date)
        .order('created_at', { ascending: true }),
    ]);
    if (p.error) setError(p.error.message);
    else setPreview(p.data as Preview);
    setMovements((m.data as Movement[] | null) ?? []);
  }, [supabase, date, opening]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  const expected = preview?.cash.expected_cents ?? 0;
  const difference = counted.trim() ? cents(counted) - expected : null;
  const needsReason = difference != null && difference !== 0 && !note.trim();
  const closed = preview?.status === 'closed';

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return false;
    }
    if (done) setNotice(done);
    await load();
    router.refresh();
    return true;
  }

  async function closeDay() {
    const ok = await run(
      () =>
        supabase.rpc('close_business_day', {
          p_business_date: date,
          p_opening_cash: cents(opening),
          p_closing_cash: counted.trim() ? cents(counted) : null,
          p_note: note.trim() || null,
        }),
      `${date} closed and locked.`,
    );
    if (ok) {
      setCounted('');
      setNote('');
    }
  }

  async function reopen(d: string) {
    const reason = window.prompt(`Reopen ${d}? This unlocks the day for corrections. Reason:`);
    if (!reason || !reason.trim()) return;
    await run(() => supabase.rpc('reopen_business_day', { p_business_date: d, p_reason: reason.trim() }), `${d} reopened.`);
  }

  async function addMovement(e: React.FormEvent) {
    e.preventDefault();
    const amount = cents(mvAmount);
    if (!amount || !mvReason.trim()) {
      setError('Enter an amount and a reason for the cash movement.');
      return;
    }
    const ok = await run(() =>
      supabase.rpc('record_cash_movement', {
        p_business_date: date,
        p_kind: mvKind,
        p_amount_cents: mvKind === 'adjustment' ? amount : Math.abs(amount),
        p_reason: mvReason.trim(),
        p_reference: mvRef.trim() || null,
      }),
    );
    if (ok) {
      setMvAmount('');
      setMvReason('');
      setMvRef('');
    }
  }

  const exceptions: string[] = [];
  if (preview) {
    const x = preview.exceptions;
    if (x.open_orders > 0) exceptions.push(`${x.open_orders} order(s) from this day are still open in the kitchen.`);
    if (x.unpaid_served_orders.count > 0)
      exceptions.push(`${x.unpaid_served_orders.count} served order(s) not fully paid — ${formatCents(x.unpaid_served_orders.cents)} outstanding.`);
    if (x.expenses_awaiting_approval > 0) exceptions.push(`${x.expenses_awaiting_approval} expense(s) dated this day still need approval.`);
    if (x.invoice_holds_open > 0) exceptions.push(`${x.invoice_holds_open} supplier-invoice exception(s) are open.`);
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <Field label="Business date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Opening float">
            <Input type="number" min="0" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" />
          </Field>
          {preview && (
            <span
              className={`mb-2 rounded px-2 py-1 text-[11px] font-bold uppercase ${closed ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}
            >
              {closed ? 'Closed · locked' : preview.is_future ? 'Not reached yet' : 'Open'}
            </span>
          )}
        </div>

        {error && <p className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        {notice && <p className="mb-3 rounded border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok">{notice}</p>}

        {preview && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <Panel title="Sales">
              <Line label="Gross sales" cents={preview.sales.gross_sales_cents} />
              <Line label="Discounts" cents={-preview.sales.discounts_cents} />
              <Line label="Refunds" cents={-preview.sales.refunds_cents} />
              <Line label="Net sales" cents={preview.sales.net_sales_cents} strong />
              <Line label="Tax collected" cents={preview.sales.tax_cents} />
              <p className="text-muted">{preview.sales.order_count} completed order(s)</p>
            </Panel>
            <Panel title="Payments received">
              {Object.keys(preview.payments_by_method).length === 0 ? (
                <p className="text-muted">No payments.</p>
              ) : (
                Object.entries(preview.payments_by_method).map(([m, c]) => <Line key={m} label={METHOD_LABEL[m] ?? m} cents={c} />)
              )}
              <div className="border-t border-border pt-1 mt-1">
                <Line label="Expenses (approved)" cents={preview.expenses.cents} />
                <Line label="Supplier payments" cents={preview.supplier_payments.cents} />
              </div>
            </Panel>
            <Panel title="Cash drawer">
              <Line label="Opening float" cents={preview.cash.opening_cents} />
              <Line label="+ Cash sales (net of refunds)" cents={preview.cash.cash_sales_cents} />
              <Line label="± Movements" cents={preview.cash.movements_cents} />
              <Line label="= Expected in drawer" cents={preview.cash.expected_cents} strong />
              {preview.cash.last_count && (
                <p className="text-muted mt-1">
                  Last count {formatCents(preview.cash.last_count.counted_cents)} at {formatDateTime(preview.cash.last_count.created_at)}
                </p>
              )}
            </Panel>
          </div>
        )}

        {exceptions.length > 0 && !closed && (
          <ul className="mt-4 space-y-1 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            {exceptions.map((x) => (
              <li key={x}>● {x}</li>
            ))}
          </ul>
        )}

        {canClose && preview && !closed && !preview.is_future && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
            <Field label="Counted cash">
              <Input type="number" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="count the drawer" />
            </Field>
            <div className="text-xs">
              <p className="text-muted">Difference</p>
              <p className={`font-mono font-bold ${difference == null ? 'text-muted' : difference === 0 ? 'text-ok' : 'text-danger'}`}>
                {difference == null ? '—' : `${difference > 0 ? '+' : ''}${formatCents(difference)}`}
              </p>
            </div>
            <Field label={difference ? 'Why is cash different? (required)' : 'Note (optional)'}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={difference ? 'e.g. change given twice' : ''} />
            </Field>
            <Button onClick={() => void closeDay()} disabled={busy || needsReason}>
              {busy ? 'Closing…' : 'Close & lock day'}
            </Button>
          </div>
        )}
        {closed && canReopen && (
          <div className="mt-4">
            <Button variant="ghost" disabled={busy} onClick={() => void reopen(date)}>
              Reopen this day
            </Button>
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted">
          Closing locks the day: its sales can&apos;t be voided or repriced and no expense, cash count or movement can be added to
          it. Refunds stay possible and count on the day they&apos;re given. Reopening needs a reason and is logged.
        </p>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">Cash movements · {date}</h2>
        {movements.length === 0 ? (
          <p className="text-muted text-xs mb-3">No pay-ins, pay-outs or bank drops recorded for this day.</p>
        ) : (
          <table className="w-full text-left text-xs mb-3">
            <tbody>
              {movements.map((m) => (
                <tr key={m.id} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-2 text-muted whitespace-nowrap">{formatDateTime(m.created_at)}</td>
                  <td className="py-1.5 pr-2 font-semibold">{KIND_LABEL[m.kind] ?? m.kind}</td>
                  <td className="py-1.5 pr-2">
                    {m.reason}
                    {m.reference && <span className="text-muted"> · {m.reference}</span>}
                  </td>
                  <td className={`py-1.5 text-right font-mono ${m.signed_cents < 0 ? 'text-danger' : 'text-ok'}`}>
                    {m.signed_cents > 0 ? '+' : ''}
                    {formatCents(m.signed_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canManageCash && !closed && !preview?.is_future && (
          <form onSubmit={addMovement} className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
            <Field label="Type">
              <Select value={mvKind} onChange={(e) => setMvKind(e.target.value)}>
                <option value="pay_out">Pay-out (cash taken out)</option>
                <option value="pay_in">Pay-in (cash added)</option>
                <option value="bank_drop">Bank drop / to safe</option>
                <option value="adjustment">Adjustment (+ or −)</option>
              </Select>
            </Field>
            <Field label="Amount">
              <Input type="number" step="0.01" value={mvAmount} onChange={(e) => setMvAmount(e.target.value)} />
            </Field>
            <Field label="Reason">
              <Input value={mvReason} onChange={(e) => setMvReason(e.target.value)} placeholder="Ice from corner shop" />
            </Field>
            <Field label="Reference">
              <Input value={mvRef} onChange={(e) => setMvRef(e.target.value)} placeholder="optional" />
            </Field>
            <Button type="submit" disabled={busy}>
              Record movement
            </Button>
          </form>
        )}
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Date</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3 font-semibold text-right">Net sales</th>
              <th className="p-3 font-semibold text-right">Expected / counted</th>
              <th className="p-3 font-semibold text-right">Difference</th>
              <th className="p-3 font-semibold">Note</th>
            </tr>
          </thead>
          <tbody>
            {closings.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-3 text-muted">
                  No days closed yet.
                </td>
              </tr>
            ) : (
              closings.map((c) => (
                <tr key={c.business_date} className="border-b border-border/60 last:border-0">
                  <td className="p-3 font-semibold">
                    <button type="button" className="underline" onClick={() => setDate(c.business_date)}>
                      {c.business_date}
                    </button>
                  </td>
                  <td className="p-3">
                    <span className={c.status === 'closed' ? 'text-ok' : 'text-warn'}>{c.status === 'closed' ? 'closed' : 'reopened'}</span>
                  </td>
                  <td className="p-3 text-right">{formatCents(c.net_sales_cents)}</td>
                  <td className="p-3 text-right font-mono">
                    {formatCents(c.expected_cash_cents ?? 0)} / {c.closing_cash_cents == null ? '—' : formatCents(c.closing_cash_cents)}
                  </td>
                  <td className={`p-3 text-right font-mono ${c.difference_cents ? 'text-danger' : ''}`}>
                    {c.difference_cents == null ? '—' : formatCents(c.difference_cents)}
                  </td>
                  <td className="p-3 text-muted">{c.note ?? ''}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border p-3 space-y-1">
      <p className="font-bold mb-1">{title}</p>
      {children}
    </div>
  );
}

function Line({ label, cents: c, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? 'font-bold' : ''}`}>
      <span className={strong ? '' : 'text-muted'}>{label}</span>
      <span className="font-mono">{formatCents(c)}</span>
    </div>
  );
}
