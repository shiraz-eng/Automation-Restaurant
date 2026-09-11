'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

export type Promo = {
  id: string;
  name: string;
  kind: 'percent' | 'fixed' | 'bogo';
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
  bogo_menu_item_id: string | null;
  bogo_buy_qty: number | null;
  bogo_get_qty: number | null;
  bogo_get_discount_bps: number | null;
  created_at: string;
};
export type PromoPerformance = {
  promotion_id: string;
  redemptions: number;
  total_discount_cents: number;
  total_order_revenue_cents: number;
};
export type MenuItemOption = { id: string; name: string };

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeValue(p: Promo, menuItems: MenuItemOption[]): string {
  if (p.kind === 'percent') return `${((p.value_bps ?? 0) / 100).toFixed(p.value_bps! % 100 ? 2 : 0)}% off`;
  if (p.kind === 'fixed') return `${formatCents(p.value_cents ?? 0)} off`;
  const itemName = menuItems.find((m) => m.id === p.bogo_menu_item_id)?.name ?? 'item';
  const discPct = (p.bogo_get_discount_bps ?? 0) / 100;
  const discLabel = discPct >= 100 ? 'free' : `${discPct}% off`;
  return `Buy ${p.bogo_buy_qty}, get ${p.bogo_get_qty} ${itemName} ${discLabel}`;
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

export function PromotionsManager({
  promos,
  performance = [],
  menuItems = [],
}: {
  promos: Promo[];
  performance?: PromoPerformance[];
  menuItems?: MenuItemOption[];
}) {
  const perfByPromo = new Map(performance.map((p) => [p.promotion_id, p]));
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'percent' | 'fixed' | 'bogo'>('percent');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [days, setDays] = useState<Set<number>>(new Set());
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [usageLimit, setUsageLimit] = useState('');
  const [autoApply, setAutoApply] = useState(false);
  const [bogoItem, setBogoItem] = useState('');
  const [bogoBuyQty, setBogoBuyQty] = useState('1');
  const [bogoGetQty, setBogoGetQty] = useState('1');
  const [bogoDiscountPct, setBogoDiscountPct] = useState('100');

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
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }

    let valueFields: { value_bps: number | null; value_cents: number | null };
    let bogoFields: {
      bogo_menu_item_id: string | null;
      bogo_buy_qty: number | null;
      bogo_get_qty: number | null;
      bogo_get_discount_bps: number | null;
    } = { bogo_menu_item_id: null, bogo_buy_qty: null, bogo_get_qty: null, bogo_get_discount_bps: null };

    if (kind === 'bogo') {
      if (!bogoItem) {
        setError('Choose which item this Buy X Get Y applies to.');
        return;
      }
      if (!code.trim()) {
        setError('A BOGO promotion needs a code — auto-apply isn\'t supported for BOGO yet.');
        return;
      }
      const buy = Math.max(1, parseInt(bogoBuyQty, 10) || 1);
      const get = Math.max(1, parseInt(bogoGetQty, 10) || 1);
      const pct = Math.min(100, Math.max(0, parseFloat(bogoDiscountPct) || 0));
      valueFields = { value_bps: null, value_cents: null };
      bogoFields = {
        bogo_menu_item_id: bogoItem,
        bogo_buy_qty: buy,
        bogo_get_qty: get,
        bogo_get_discount_bps: Math.round(pct * 100),
      };
    } else {
      const n = parseFloat(amount);
      if (Number.isNaN(n) || n <= 0) {
        setError('Enter a positive amount.');
        return;
      }
      if (kind === 'percent' && n > 100) {
        setError('A percentage discount cannot exceed 100%.');
        return;
      }
      valueFields = {
        value_bps: kind === 'percent' ? Math.round(n * 100) : null,
        value_cents: kind === 'fixed' ? Math.round(n * 100) : null,
      };
    }

    const limit = usageLimit.trim() ? Math.max(1, parseInt(usageLimit, 10) || 1) : null;
    const row = {
      name: name.trim(),
      kind,
      ...valueFields,
      ...bogoFields,
      code: code.trim() ? code.trim().toUpperCase() : null,
      min_subtotal_cents: minSubtotal ? Math.round(parseFloat(minSubtotal) * 100) : 0,
      active: true,
      days_of_week: days.size ? Array.from(days).sort() : null,
      start_time: startTime || null,
      end_time: endTime || null,
      usage_limit_total: limit,
      auto_apply: kind === 'bogo' ? false : autoApply,
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
      setBogoItem('');
      setBogoBuyQty('1');
      setBogoGetQty('1');
      setBogoDiscountPct('100');
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
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'fixed' | 'bogo')}>
              <option value="percent">Percent</option>
              <option value="fixed">Fixed amount</option>
              <option value="bogo">Buy X Get Y (BOGO)</option>
            </Select>
          </Field>
          {kind !== 'bogo' && (
            <Field label={kind === 'percent' ? 'Percent (%)' : 'Amount (USD)'}>
              <Input
                type="number"
                step={kind === 'percent' ? '1' : '0.01'}
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          )}
          <Field label={kind === 'bogo' ? 'Code (required for BOGO)' : 'Code (optional)'}>
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

        {kind === 'bogo' && (
          <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-end gap-3">
            <Field label="Item">
              <Select value={bogoItem} onChange={(e) => setBogoItem(e.target.value)} className="w-48">
                <option value="">Choose item…</option>
                {menuItems.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Buy qty">
              <Input type="number" min="1" value={bogoBuyQty} onChange={(e) => setBogoBuyQty(e.target.value)} className="w-16" />
            </Field>
            <Field label="Get qty">
              <Input type="number" min="1" value={bogoGetQty} onChange={(e) => setBogoGetQty(e.target.value)} className="w-16" />
            </Field>
            <Field label="Discount on the 'get' item (%)">
              <Input
                type="number"
                min="0"
                max="100"
                value={bogoDiscountPct}
                onChange={(e) => setBogoDiscountPct(e.target.value)}
                className="w-20"
              />
            </Field>
            <span className="text-[11px] text-muted pb-2">100% = free. The cheapest qualifying units are discounted first.</span>
          </div>
        )}

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
            {kind !== 'bogo' && (
              <label className="flex items-center gap-1.5 text-xs pb-2">
                <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
                Auto-apply (no code needed)
              </label>
            )}
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
                  <td className="p-3">{describeValue(p, menuItems)}</td>
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
