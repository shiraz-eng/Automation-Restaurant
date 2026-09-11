'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

export type Promo = {
  id: string;
  name: string;
  kind: 'percent' | 'fixed';
  value_bps: number | null;
  value_cents: number | null;
  code: string | null;
  min_subtotal_cents: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  usage_limit_total: number | null;
  usage_count: number;
  auto_apply: boolean;
  created_at: string;
};
export type PromoPerformance = {
  promotion_id: string;
  redemptions: number;
  total_discount_cents: number;
  total_order_revenue_cents: number;
};

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeValue(p: Promo): string {
  if (p.kind === 'percent') return `${((p.value_bps ?? 0) / 100).toFixed(p.value_bps! % 100 ? 2 : 0)}% off`;
  return `${formatCents(p.value_cents ?? 0)} off`;
}

function describeSchedule(p: Promo): string {
  const days = p.days_of_week?.length ? p.days_of_week.slice().sort().map((d) => DOW_LABELS[d]).join(',') : 'every day';
  const time = p.start_time && p.end_time ? `${p.start_time.slice(0, 5)}–${p.end_time.slice(0, 5)}` : 'all day';
  if (!p.days_of_week?.length && !p.start_time && !p.end_time) return 'always on';
  return `${days} · ${time}`;
}

function describeUsage(p: Promo): string {
  if (p.usage_limit_total == null) return `${p.usage_count} used`;
  return `${p.usage_count} / ${p.usage_limit_total}`;
}

export function PromotionsManager({ promos, performance = [] }: { promos: Promo[]; performance?: PromoPerformance[] }) {
  const perfByPromo = new Map(performance.map((p) => [p.promotion_id, p]));
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [days, setDays] = useState<Set<number>>(new Set());
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [usageLimit, setUsageLimit] = useState('');
  const [autoApply, setAutoApply] = useState(false);

  function toggleDay(d: number) {
    setDays((s) => {
      const next = new Set(s);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(error.message);
      return false;
    }
    router.refresh();
    return true;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(amount);
    if (!name.trim() || Number.isNaN(n) || n <= 0) {
      setError('Enter a name and a positive amount.');
      return;
    }
    if (kind === 'percent' && n > 100) {
      setError('A percentage discount cannot exceed 100%.');
      return;
    }
    const limit = usageLimit.trim() ? Math.max(1, parseInt(usageLimit, 10) || 1) : null;
    const row = {
      name: name.trim(),
      kind,
      value_bps: kind === 'percent' ? Math.round(n * 100) : null,
      value_cents: kind === 'fixed' ? Math.round(n * 100) : null,
      code: code.trim() ? code.trim().toUpperCase() : null,
      min_subtotal_cents: minSubtotal ? Math.round(parseFloat(minSubtotal) * 100) : 0,
      active: true,
      days_of_week: days.size ? Array.from(days).sort() : null,
      start_time: startTime || null,
      end_time: endTime || null,
      usage_limit_total: limit,
      auto_apply: autoApply,
    };
    const ok = await run(() => supabase.from('promotions').insert(row));
    if (ok) {
      setName('');
      setAmount('');
      setCode('');
      setMinSubtotal('');
      setDays(new Set());
      setStartTime('');
      setEndTime('');
      setUsageLimit('');
      setAutoApply(false);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      <Card>
        <h2 className="font-bold mb-3 text-sm">New promotion</h2>
        <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-6 gap-3 items-end">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'fixed')}>
              <option value="percent">Percent</option>
              <option value="fixed">Fixed amount</option>
            </Select>
          </Field>
          <Field label={kind === 'percent' ? 'Percent (%)' : 'Amount (USD)'}>
            <Input
              type="number"
              step={kind === 'percent' ? '1' : '0.01'}
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Code (optional)">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="SUMMER10"
            />
          </Field>
          <Field label="Min. subtotal (USD)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={minSubtotal}
              onChange={(e) => setMinSubtotal(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>

        <div className="mt-4 pt-3 border-t border-border">
          <span className="text-[11px] font-semibold text-muted">
            Schedule &amp; usage limit (optional)
          </span>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <div>
              <span className="block text-[11px] text-muted mb-1">Days (blank = every day)</span>
              <div className="flex gap-1">
                {DOW_LABELS.map((label, d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    className={`w-9 h-7 rounded text-[11px] font-semibold border ${
                      days.has(d) ? 'bg-primary text-primary-fg border-primary' : 'border-border text-muted'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Field label="Starts at (blank = all day)">
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-28" />
            </Field>
            <Field label="Ends at">
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-28" />
            </Field>
            <Field label="Usage limit (blank = unlimited)">
              <Input
                type="number"
                min="1"
                value={usageLimit}
                onChange={(e) => setUsageLimit(e.target.value)}
                className="w-24"
              />
            </Field>
            <label className="flex items-center gap-1.5 text-xs pb-2">
              <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
              Auto-apply (no code needed)
            </label>
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Promotion</th>
              <th className="p-3 font-semibold">Discount</th>
              <th className="p-3 font-semibold">Code</th>
              <th className="p-3 font-semibold text-right">Min. subtotal</th>
              <th className="p-3 font-semibold">Schedule</th>
              <th className="p-3 font-semibold">Usage</th>
              <th className="p-3 font-semibold text-right">Revenue</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {promos.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-3 text-muted">
                  No promotions yet.
                </td>
              </tr>
            ) : (
              promos.map((p) => {
                const perf = perfByPromo.get(p.id);
                return (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <td className="p-3 font-semibold">
                    {p.name}
                    {p.auto_apply && (
                      <span className="ml-1.5 rounded bg-ok/15 text-ok px-1.5 py-0.5 text-[10px] font-bold align-middle">
                        AUTO
                      </span>
                    )}
                  </td>
                  <td className="p-3">{describeValue(p)}</td>
                  <td className="p-3 font-mono">{p.code ?? '—'}</td>
                  <td className="p-3 text-right text-muted">
                    {p.min_subtotal_cents ? formatCents(p.min_subtotal_cents) : '—'}
                  </td>
                  <td className="p-3 text-muted">{describeSchedule(p)}</td>
                  <td className="p-3 text-muted">{describeUsage(p)}</td>
                  <td className="p-3 text-right text-muted">
                    {perf ? formatCents(perf.total_discount_cents) + ' given' : '—'}
                  </td>
                  <td className="p-3">
                    <span className={p.active ? 'text-ok' : 'text-muted'}>
                      {p.active ? 'active' : 'paused'}
                    </span>
                  </td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          supabase
                            .from('promotions')
                            .update({ active: !p.active })
                            .eq('id', p.id),
                        )
                      }
                    >
                      {p.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button
                      variant="danger"
                      className="ml-1.5"
                      disabled={busy}
                      onClick={() =>
                        run(() => supabase.from('promotions').delete().eq('id', p.id))
                      }
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
