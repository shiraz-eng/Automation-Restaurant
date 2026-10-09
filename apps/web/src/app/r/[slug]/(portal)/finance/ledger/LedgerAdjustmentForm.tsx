'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';

const ADJUSTABLE: [string, string][] = [
  ['revenue', 'Sales'],
  ['cogs', 'Food cost'],
  ['payment', 'Customer payments'],
  ['expense', 'Expenses'],
  ['payable', 'Supplier payables'],
  ['inventory', 'Inventory value'],
  ['waste', 'Waste'],
  ['cash', 'Cash'],
];

const ERRORS: Record<string, string> = {
  forbidden: 'You do not have permission to adjust the ledger.',
  reason_required: 'Write why this correction is needed.',
  bad_amount: 'Enter an amount other than zero.',
  bad_category: 'Choose a category.',
};

/** Manual ledger correction (post_ledger_adjustment) — needs finance.adjust_ledger. */
export function LedgerAdjustmentForm({ defaultDate }: { defaultDate: string }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('expense');
  const [direction, setDirection] = useState<1 | -1>(1);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded border border-border px-3 py-1.5 text-xs font-semibold">
        + Post a correction
      </button>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setMessage({ ok: false, text: ERRORS.bad_amount });
    if (!reason.trim()) return setMessage({ ok: false, text: ERRORS.reason_required });
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.rpc('post_ledger_adjustment', {
      p_category: category,
      p_amount_cents: direction * cents,
      p_reason: reason.trim(),
      p_business_date: date || null,
    });
    setBusy(false);
    if (error) return setMessage({ ok: false, text: ERRORS[error.message] ?? error.message });
    setAmount('');
    setReason('');
    setMessage({ ok: true, text: 'Correction posted and recorded in the audit log.' });
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="rounded-lg border border-border bg-surface p-3 space-y-2 text-xs">
      <p className="font-bold">Post a correction</p>
      <p className="text-muted">
        Adds a new adjustment entry; nothing existing is changed. Use it only to fix a figure the automatic entries got wrong.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
            {ADJUSTABLE.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(Number(e.target.value) as 1 | -1)}
            className="rounded border border-border bg-surface px-2 py-1"
          >
            <option value={1}>Increase (+)</option>
            <option value={-1}>Decrease (−)</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Amount</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-28 rounded border border-border bg-surface px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">Business day</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" />
        </label>
        <label className="flex flex-col gap-0.5 grow min-w-[12rem]">
          <span className="text-muted">Reason (required)</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="e.g. Cash sale recorded twice on 3 Oct"
            className="rounded border border-border bg-surface px-2 py-1"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="rounded bg-primary px-3 py-1 font-semibold text-primary-fg disabled:opacity-60">
          {busy ? 'Posting…' : 'Post correction'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-muted">
          Close
        </button>
        {message && <span className={message.ok ? 'text-ok' : 'text-danger'}>{message.text}</span>}
      </div>
    </form>
  );
}
