'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import {
  WASTE_REASONS,
  WASTE_REASON_LABELS,
  toBaseQty,
  wasteErrorMessage,
  wasteTrend,
  wasteUnitOptions,
  type TrendGrain,
  type WastageDailyRow,
  type WasteReason,
} from '@automation-restaurant/shared';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { axisMoney, formatCents } from '@/lib/format';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type WasteItem = {
  id: string;
  name: string;
  unit: string;
  stock_qty: number;
  min_threshold: number;
  purchase_unit_label: string | null;
  purchase_unit_to_base: number | null;
};
export type Member = { id: string; full_name: string | null; email: string };

function newRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

/** Record waste. Approvers' entries deduct stock at once; others wait for approval. */
export function WasteEntryForm({ items, members, today, canApprove }: { items: WasteItem[]; members: Member[]; today: string; canApprove: boolean }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const { slug } = useParams<{ slug: string }>();
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState<WasteReason>('spoilage');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today);
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // One id per filled-in form: a double click or a retry after a dropped connection records it once.
  const [requestId, setRequestId] = useState(newRequestId);

  const item = items.find((i) => i.id === itemId) ?? null;
  const options = item ? wasteUnitOptions(item) : [];
  const chosenUnit = unit || item?.unit || '';
  const base = item ? toBaseQty(item, Number(qty), chosenUnit) : null;
  const tooMuch = !!item && base !== null && canApprove && base > Number(item.stock_qty);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (!item) return setError('Choose an ingredient.');
    if (base === null) return setError('Enter a quantity above zero.');
    if (reason === 'other' && !note.trim()) return setError('Add a note explaining the reason.');
    setBusy(true);
    const { data, error: err } = await supabase.rpc('record_waste_entry', {
      p_inventory_item_id: item.id,
      p_qty: Number(qty),
      p_unit: chosenUnit,
      p_reason: reason,
      p_note: note.trim() || null,
      p_occurred_on: date,
      p_responsible_member_id: member || null,
      p_request_id: requestId,
    });
    setBusy(false);
    if (err) return setError(wasteErrorMessage(err.message));
    const status = (data as { status?: string } | null)?.status;
    setDone(
      status === 'approved'
        ? `Recorded: ${qty} ${chosenUnit} of ${item.name}. Stock updated.`
        : `Sent for approval: ${qty} ${chosenUnit} of ${item.name}. Stock changes once a manager approves it.`,
    );
    setQty('');
    setNote('');
    setRequestId(newRequestId());
    router.refresh();
    // Same low-stock reorder sweep the Inventory screen triggers after waste.
    if (status === 'approved' && Number(item.stock_qty) - base <= Number(item.min_threshold)) {
      supabase.auth.getSession().then(({ data: { session } }) => {
        fetch(`${API}/api/inventory/low-stock/sweep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
          body: JSON.stringify({ slug }),
        }).catch(() => {});
      });
    }
  }

  return (
    <Card>
      <h2 className="mb-1 text-sm font-bold">Record waste</h2>
      <p className="mb-4 text-xs text-muted">
        {canApprove ? 'Stock is deducted as soon as you save.' : 'A manager approves it before stock is deducted.'}
      </p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Ingredient">
          <Select
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              setUnit('');
            }}
            required
          >
            <option value="">Choose…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({Number(i.stock_qty)} {i.unit} in stock)
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field
            label="Quantity"
            error={tooMuch ? `Only ${Number(item?.stock_qty)} ${item?.unit} in stock.` : null}
            hint={item && base !== null && chosenUnit.toLowerCase() !== item.unit.toLowerCase() ? `= ${base} ${item.unit}` : undefined}
          >
            <Input type="number" inputMode="decimal" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required />
          </Field>
          <Field label="Unit">
            <Select value={chosenUnit} onChange={(e) => setUnit(e.target.value)} disabled={!item} aria-label="Unit">
              {(options.length ? options : [{ unit: '—', factor: 1 }]).map((o) => (
                <option key={o.unit} value={o.unit}>
                  {o.unit}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Reason">
          <Select value={reason} onChange={(e) => setReason(e.target.value as WasteReason)}>
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r}>
                {WASTE_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={reason === 'other' ? 'Note (required)' : 'Note'}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What happened" required={reason === 'other'} />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Responsible">
          <Select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">Me</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.email}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
          <Button type="submit" disabled={busy || tooMuch}>
            {busy ? 'Saving…' : canApprove ? 'Record waste' : 'Send for approval'}
          </Button>
          {error && (
            <span role="alert" className="text-xs font-semibold text-danger">
              ⚠ {error}
            </span>
          )}
          {done && (
            <span role="status" className="text-xs font-semibold text-ok">
              ✓ {done}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

/** Approve / reject / reverse one entry (the database re-checks permission and state). */
export function WasteEntryActions({ id, status, canApprove }: { id: string; status: string; canApprove: boolean }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!canApprove || (status !== 'pending' && status !== 'approved')) return null;

  async function act(fn: 'approve_waste_entry' | 'reject_waste_entry' | 'reverse_waste_entry') {
    let note: string | null = null;
    if (fn !== 'approve_waste_entry') {
      note = window.prompt(fn === 'reject_waste_entry' ? 'Why is this entry rejected?' : 'Why is this waste being reversed? Stock will be put back.');
      if (!note?.trim()) return;
    }
    setBusy(true);
    setError(null);
    const args = fn === 'reverse_waste_entry' ? { p_id: id, p_reason: note } : { p_id: id, p_note: note };
    const { error: err } = await supabase.rpc(fn, args);
    setBusy(false);
    if (err) return setError(wasteErrorMessage(err.message));
    router.refresh();
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {status === 'pending' ? (
        <>
          <Button type="button" onClick={() => act('approve_waste_entry')} disabled={busy}>
            Approve
          </Button>
          <Button type="button" variant="ghost" onClick={() => act('reject_waste_entry')} disabled={busy}>
            Reject
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" onClick={() => act('reverse_waste_entry')} disabled={busy}>
          Reverse
        </Button>
      )}
      {error && (
        <span role="alert" className="text-[0.6875rem] font-semibold text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/** Waste cost by day, week or month. */
export function WasteTrendChart({ daily, from, to, costsVisible }: { daily: WastageDailyRow[]; from: string; to: string; costsVisible: boolean }) {
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const [grain, setGrain] = useState<TrendGrain>(span > 120 ? 'month' : span > 35 ? 'week' : 'day');
  const rows = useMemo(
    () => wasteTrend(daily, from, to, grain).map((r) => ({ ...r, value: costsVisible ? (r.cost_cents ?? 0) / 100 : r.events })),
    [daily, from, to, grain, costsVisible],
  );
  const label = (b: string) =>
    grain === 'month'
      ? new Date(`${b}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
      : new Date(`${b}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{costsVisible ? 'Waste cost over time' : 'Waste entries over time'}</h2>
        <div className="flex gap-1 text-xs" role="group" aria-label="Group by">
          {(['day', 'week', 'month'] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={grain === g}
              onClick={() => setGrain(g)}
              className={`rounded-full border px-3 py-1 ${grain === g ? 'border-primary bg-primary text-primary-fg' : 'border-border hover:border-primary/60'}`}
            >
              {g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>
      <div className="h-56" role="img" aria-label={`${costsVisible ? 'Waste cost' : 'Waste entries'} by ${grain}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--border-color))" vertical={false} />
            <XAxis dataKey="bucket" tickFormatter={label} tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }} minTickGap={12} />
            <YAxis
              width={56}
              tick={{ fontSize: 11, fill: 'rgb(var(--text-muted))' }}
              tickFormatter={(v: number) => (costsVisible ? axisMoney(v) : String(v))}
              allowDecimals={!costsVisible ? false : true}
            />
            <Tooltip
              cursor={{ fill: 'rgb(var(--border-color) / 0.4)' }}
              labelFormatter={(b) => label(String(b))}
              formatter={(v: number) => [costsVisible ? formatCents(Math.round(v * 100)) : v, costsVisible ? 'Waste cost' : 'Entries']}
              contentStyle={{ background: 'rgb(var(--bg-surface))', border: '1px solid rgb(var(--border-color))', fontSize: 12 }}
            />
            <Bar dataKey="value" fill="rgb(var(--danger))" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** Shelf life per ingredient, used for the expiry estimates. */
export function ShelfLifeEditor({ items, shelf }: { items: WasteItem[]; shelf: Record<string, number> }) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [itemId, setItemId] = useState('');
  const [days, setDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!itemId) return;
    const n = days.trim() === '' ? null : Math.round(Number(days));
    if (n !== null && !(n >= 1 && n <= 3650)) return setError('Shelf life is 1 to 3650 days (leave empty to remove).');
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc('set_shelf_life', { p_inventory_item_id: itemId, p_days: n });
    setBusy(false);
    if (err) return setError(wasteErrorMessage(err.message));
    setDays('');
    router.refresh();
  }

  return (
    <form onSubmit={save} className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
      <Field label="Ingredient">
        <Select
          value={itemId}
          onChange={(e) => {
            setItemId(e.target.value);
            setDays(shelf[e.target.value] ? String(shelf[e.target.value]) : '');
          }}
        >
          <option value="">Choose…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
              {shelf[i.id] ? ` — ${shelf[i.id]} days` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Shelf life (days)">
        <Input type="number" min="1" max="3650" step="1" value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 3" />
      </Field>
      <Button type="submit" disabled={busy || !itemId}>
        {busy ? 'Saving…' : 'Save shelf life'}
      </Button>
      {error && (
        <span role="alert" className="text-xs font-semibold text-danger sm:col-span-3">
          ⚠ {error}
        </span>
      )}
    </form>
  );
}
