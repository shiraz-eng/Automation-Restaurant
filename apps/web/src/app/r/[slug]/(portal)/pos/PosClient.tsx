'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Category = { id: string; name: string };
type Variant = { id: string; name: string; price_cents: number; sort_order: number; is_available: boolean };
type RawItem = { id: string; name: string; category_id: string | null; menu_variants: Variant[] };
type Item = { id: string; name: string; price_cents: number; category_id: string | null };
type CartLine = { item: Item; qty: number };
type Placed = { order_id: string; order_number: number; total_cents: number; discount_cents: number };

const CHANNELS = ['dine_in', 'takeaway', 'delivery'] as const;
const METHODS = ['cash', 'card', 'mobile'] as const;

/** One row per available variant, labelled with its item. id = variant id. */
function toProducts(items: RawItem[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    for (const v of (it.menu_variants ?? [])
      .filter((x) => x.is_available)
      .sort((a, b) => a.sort_order - b.sort_order)) {
      out.push({
        id: v.id,
        name: v.name === 'Regular' ? it.name : `${it.name} · ${v.name}`,
        price_cents: v.price_cents,
        category_id: it.category_id,
      });
    }
  }
  return out;
}

export function PosClient({
  taxRateBps,
  categories,
  items,
}: {
  taxRateBps: number;
  categories: Category[];
  items: RawItem[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [activeCat, setActiveCat] = useState<string>('all');
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const products = useMemo(() => toProducts(items), [items]);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('dine_in');
  const [table, setTable] = useState('');
  const [promo, setPromo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]>('cash');
  const [tendered, setTendered] = useState('');
  const [paid, setPaid] = useState(false);

  const shown = products.filter((i) => activeCat === 'all' || i.category_id === activeCat);
  const lines = Object.values(cart);
  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.item.price_cents * l.qty, 0),
    [lines],
  );
  const tax = Math.round((subtotal * taxRateBps) / 10000);
  const total = subtotal + tax;

  function add(item: Item) {
    setPlaced(null);
    setPaid(false);
    setCart((c) => ({ ...c, [item.id]: { item, qty: (c[item.id]?.qty ?? 0) + 1 } }));
  }
  function bump(id: string, delta: number) {
    setCart((c) => {
      const next = { ...c };
      const line = next[id];
      if (!line) return c;
      const qty = line.qty + delta;
      if (qty <= 0) delete next[id];
      else next[id] = { ...line, qty };
      return next;
    });
  }

  async function send() {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('place_order', {
      p_channel: channel,
      p_table_label: table.trim() || null,
      p_customer_name: null,
      p_tax_rate_bps: taxRateBps,
      p_lines: lines.map((l) => ({ variant_id: l.item.id, qty: l.qty })),
      p_promo_code: promo.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (promo.trim() && (row.discount_cents ?? 0) === 0) {
      setError(`Code "${promo.trim()}" isn’t valid — order sent at full price.`);
    }
    setPlaced({
      order_id: row.order_id,
      order_number: row.order_number,
      total_cents: row.total_cents,
      discount_cents: row.discount_cents ?? 0,
    });
    setPaid(false);
    setMethod('cash');
    setTendered('');
    setCart({});
    setTable('');
    setPromo('');
    router.refresh();
  }

  const tenderedCents = tendered.trim() ? Math.round(parseFloat(tendered) * 100) : null;
  const change =
    method === 'cash' && tenderedCents != null && placed ? tenderedCents - placed.total_cents : null;

  async function takePayment() {
    if (!placed) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.rpc('record_payment', {
      p_order_id: placed.order_id,
      p_amount_cents: placed.total_cents,
      p_method: method,
      p_tendered_cents: method === 'cash' ? tenderedCents : null,
      p_reference: null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPaid(true);
    router.refresh();
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="flex-1 min-w-0 space-y-3">
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setActiveCat('all')}
            className={`px-3 py-1.5 rounded text-xs font-semibold whitespace-nowrap ${
              activeCat === 'all' ? 'bg-primary text-primary-fg' : 'bg-surface border border-border'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveCat(c.id)}
              className={`px-3 py-1.5 rounded text-xs font-semibold whitespace-nowrap ${
                activeCat === c.id
                  ? 'bg-primary text-primary-fg'
                  : 'bg-surface border border-border'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {shown.length === 0 ? (
            <Card className="col-span-full text-muted text-xs">No available items.</Card>
          ) : (
            shown.map((it) => (
              <button
                key={it.id}
                onClick={() => add(it)}
                className="rounded-lg border border-border bg-surface p-3 text-left hover:border-primary transition-colors"
              >
                <div className="font-semibold text-xs">{it.name}</div>
                <div className="text-primary font-bold text-sm mt-1">
                  {formatCents(it.price_cents)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      <Card className="w-full lg:w-80 shrink-0 self-start">
        <h2 className="font-bold text-sm mb-3">Ticket</h2>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </Select>
          <Input placeholder="Table" value={table} onChange={(e) => setTable(e.target.value)} />
          <Input
            placeholder="Promo code"
            value={promo}
            onChange={(e) => setPromo(e.target.value)}
            className="col-span-2 uppercase placeholder:normal-case"
          />
        </div>

        {lines.length === 0 ? (
          <p className="text-muted text-xs py-6 text-center">Tap items to add them.</p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {lines.map((l) => (
              <div key={l.item.id} className="flex items-center justify-between text-xs">
                <span className="truncate flex-1">{l.item.name}</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => bump(l.item.id, -1)}
                    className="w-5 h-5 rounded border border-border font-bold"
                  >
                    −
                  </button>
                  <span className="w-4 text-center">{l.qty}</span>
                  <button
                    onClick={() => bump(l.item.id, 1)}
                    className="w-5 h-5 rounded border border-border font-bold"
                  >
                    +
                  </button>
                  <span className="w-14 text-right font-semibold">
                    {formatCents(l.item.price_cents * l.qty)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border pt-2 space-y-1 text-xs text-muted">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tax ({(taxRateBps / 100).toFixed(0)}%)</span>
            <span>{formatCents(tax)}</span>
          </div>
          <div className="flex justify-between text-body font-black text-sm pt-1">
            <span>Total</span>
            <span>{formatCents(total)}</span>
          </div>
        </div>

        {error && <p className="text-danger text-xs mt-2">{error}</p>}

        {placed && !paid && (
          <div className="mt-3 pt-3 border-t border-border space-y-2">
            <p className="text-ok text-xs">
              Order #{placed.order_number} sent · {formatCents(placed.total_cents)}
              {placed.discount_cents > 0 && ` · ${formatCents(placed.discount_cents)} off`}
            </p>
            <div className="text-[10px] uppercase tracking-wide text-muted font-bold">Take payment</div>
            <div className="grid grid-cols-3 gap-2">
              {METHODS.map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`rounded py-1.5 text-xs font-semibold capitalize ${
                    method === m ? 'bg-primary text-primary-fg' : 'border border-border'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            {method === 'cash' && (
              <Input
                placeholder="Cash tendered"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
              />
            )}
            {change != null && (
              <p className={`text-xs font-bold ${change < 0 ? 'text-danger' : 'text-ok'}`}>
                {change < 0 ? 'Short ' : 'Change '}
                {formatCents(Math.abs(change))}
              </p>
            )}
            <Button
              className="w-full"
              disabled={busy || (method === 'cash' && (change ?? 0) < 0)}
              onClick={takePayment}
            >
              {busy ? 'Working…' : `Take ${formatCents(placed.total_cents)}`}
            </Button>
          </div>
        )}
        {placed && paid && (
          <p className="text-ok text-xs font-bold mt-3 pt-3 border-t border-border">
            Order #{placed.order_number} paid ({method}) · {formatCents(placed.total_cents)}
          </p>
        )}

        <Button
          className="w-full mt-3 py-2.5 text-sm"
          disabled={busy || lines.length === 0}
          onClick={send}
        >
          {busy ? 'Sending…' : 'Send to kitchen'}
        </Button>
      </Card>
    </div>
  );
}
