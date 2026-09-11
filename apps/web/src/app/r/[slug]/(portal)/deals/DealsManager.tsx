'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Component = {
  id: string;
  menu_item_id: string | null;
  variant_id: string | null;
  qty: number;
  sort_order: number;
};
export type Deal = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  price_cents: number;
  is_available: boolean;
  track_availability: boolean;
  available_qty: number;
  starts_at: string | null;
  ends_at: string | null;
  sort_order: number;
  deal_components: Component[];
};
export type MenuOption = {
  id: string;
  name: string;
  menu_variants: { id: string; name: string; price_cents: number }[];
};

export function DealsManager({
  deals,
  menu,
  canEdit,
}: {
  deals: Deal[];
  menu: MenuOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // per-deal component draft
  const [pick, setPick] = useState<Record<string, { item: string; variant: string; qty: string }>>(
    {},
  );

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) setError(e.message);
    else router.refresh();
  }

  async function createDeal(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(price || '0') * 100);
    if (name.trim().length < 2 || cents < 0) {
      setError('Name and a price are required.');
      return;
    }
    await run(() => supabase.from('deals').insert({ name: name.trim(), price_cents: cents }));
    setName('');
    setPrice('');
  }

  function itemName(id: string | null) {
    return menu.find((m) => m.id === id)?.name ?? '—';
  }
  function variantName(itemId: string | null, vId: string | null) {
    if (!vId) return null;
    return menu.find((m) => m.id === itemId)?.menu_variants.find((v) => v.id === vId)?.name ?? null;
  }

  return (
    <div className="space-y-5">
      {canEdit && (
        <Card>
          <h2 className="font-bold text-sm mb-3">New deal</h2>
          <form onSubmit={createDeal} className="flex gap-3 items-end flex-wrap">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Price">
              <Input
                type="number"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-28"
              />
            </Field>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </form>
          {error && <p className="text-danger text-xs mt-2">{error}</p>}
        </Card>
      )}

      {deals.length === 0 ? (
        <p className="text-muted text-xs">No deals yet.</p>
      ) : (
        deals.map((d) => {
          const p = pick[d.id] ?? { item: '', variant: '', qty: '1' };
          const variants = menu.find((m) => m.id === p.item)?.menu_variants ?? [];
          return (
            <Card key={d.id}>
              <div className="flex items-baseline justify-between">
                <span className="font-bold text-sm">{d.name}</span>
                <span className="text-primary font-bold text-sm">{formatCents(d.price_cents)}</span>
              </div>
              {d.description && <p className="text-xs text-muted mt-1">{d.description}</p>}

              <div className="mt-3 space-y-1">
                {d.deal_components.length === 0 ? (
                  <p className="text-muted text-xs">No components — add at least one.</p>
                ) : (
                  d.deal_components.map((c) => (
                    <div key={c.id} className="flex items-center justify-between text-xs">
                      <span>
                        {c.qty}× {itemName(c.menu_item_id)}
                        {variantName(c.menu_item_id, c.variant_id)
                          ? ` · ${variantName(c.menu_item_id, c.variant_id)}`
                          : ''}
                      </span>
                      {canEdit && (
                        <button
                          onClick={() =>
                            run(() => supabase.from('deal_components').delete().eq('id', c.id))
                          }
                          className="text-danger underline"
                        >
                          remove
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {canEdit && (
                <>
                  <div className="mt-3 flex flex-wrap gap-2 items-end">
                    <Select
                      value={p.item}
                      onChange={(e) =>
                        setPick((s) => ({
                          ...s,
                          [d.id]: { item: e.target.value, variant: '', qty: p.qty },
                        }))
                      }
                      className="text-xs"
                    >
                      <option value="">Item…</option>
                      {menu.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      value={p.variant}
                      onChange={(e) =>
                        setPick((s) => ({ ...s, [d.id]: { ...p, variant: e.target.value } }))
                      }
                      className="text-xs"
                    >
                      <option value="">Any variant</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      type="number"
                      min="1"
                      value={p.qty}
                      onChange={(e) =>
                        setPick((s) => ({ ...s, [d.id]: { ...p, qty: e.target.value } }))
                      }
                      className="w-16 text-xs"
                    />
                    <Button
                      variant="ghost"
                      disabled={busy || !p.item}
                      onClick={() =>
                        run(() =>
                          supabase.from('deal_components').insert({
                            deal_id: d.id,
                            menu_item_id: p.item,
                            variant_id: p.variant || null,
                            qty: Math.max(1, parseInt(p.qty, 10) || 1),
                          }),
                        )
                      }
                    >
                      Add component
                    </Button>
                  </div>

                  <div className="mt-3 flex gap-2 text-xs">
                    <button
                      onClick={() =>
                        run(() =>
                          supabase
                            .from('deals')
                            .update({ is_available: !d.is_available })
                            .eq('id', d.id),
                        )
                      }
                      className="rounded border border-border px-2 py-1 font-semibold"
                    >
                      {d.is_available ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete "${d.name}"?`))
                          run(() => supabase.from('deals').delete().eq('id', d.id));
                      }}
                      className="rounded border border-danger text-danger px-2 py-1 font-semibold"
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
