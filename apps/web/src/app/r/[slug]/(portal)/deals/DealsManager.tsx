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
type OptionItem = {
  id: string;
  menu_item_id: string | null;
  variant_id: string | null;
  qty: number;
  price_adjustment_cents: number;
  is_default: boolean;
  sort_order: number;
};
type OptionGroup = {
  id: string;
  name: string;
  min_select: number;
  max_select: number | null;
  sort_order: number;
  deal_option_items: OptionItem[];
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
  deal_option_groups: OptionGroup[];
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
  canCreate = canEdit,
  canArchive = canEdit,
}: {
  deals: Deal[];
  menu: MenuOption[];
  /** deals.update — edit a deal's contents (components, option groups). */
  canEdit: boolean;
  /** deals.create — the deals_create insert policy (0058). */
  canCreate?: boolean;
  /** deals.archive — take a deal off sale (set_deal_available) or delete it. */
  canArchive?: boolean;
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
  // per-deal "new Build-Your-Own group" draft
  const [groupDraft, setGroupDraft] = useState<Record<string, { name: string; min: string; max: string }>>({});
  // per-group "new option item" draft, keyed by group id
  const [optDraft, setOptDraft] = useState<
    Record<string, { item: string; variant: string; qty: string; price: string; isDefault: boolean }>
  >({});

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
      {canCreate && (
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
                </>
              )}

              <div className="mt-4 pt-3 border-t border-border">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="font-bold text-xs">Build Your Own (optional)</span>
                  <span className="text-[11px] text-muted">
                    Selectable groups on top of the fixed price above — e.g. &quot;Choose Size&quot;, &quot;Choose Side&quot;
                  </span>
                </div>
                {d.deal_option_groups.length === 0 ? (
                  <p className="text-muted text-xs">No option groups — this stays a plain fixed combo.</p>
                ) : (
                  <div className="space-y-3">
                    {d.deal_option_groups.map((g) => {
                      const od = optDraft[g.id] ?? { item: '', variant: '', qty: '1', price: '0', isDefault: false };
                      const odVariants = menu.find((m) => m.id === od.item)?.menu_variants ?? [];
                      return (
                        <div key={g.id} className="rounded border border-border p-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold">
                              {g.name}{' '}
                              <span className="text-muted font-normal">
                                (pick {g.min_select}
                                {g.max_select != null && g.max_select !== g.min_select ? `–${g.max_select}` : ''}
                                {g.max_select == null ? '+' : ''})
                              </span>
                            </span>
                            {canEdit && (
                              <button
                                onClick={() => {
                                  if (confirm(`Delete group "${g.name}"?`))
                                    run(() => supabase.from('deal_option_groups').delete().eq('id', g.id));
                                }}
                                className="text-danger underline"
                              >
                                remove group
                              </button>
                            )}
                          </div>
                          <div className="mt-1.5 space-y-1">
                            {g.deal_option_items.length === 0 ? (
                              <p className="text-muted text-[11px]">No options yet — add at least {g.min_select || 1}.</p>
                            ) : (
                              g.deal_option_items.map((oi) => (
                                <div key={oi.id} className="flex items-center justify-between text-[11px]">
                                  <span>
                                    {oi.qty}× {itemName(oi.menu_item_id)}
                                    {variantName(oi.menu_item_id, oi.variant_id)
                                      ? ` · ${variantName(oi.menu_item_id, oi.variant_id)}`
                                      : ''}
                                    {oi.price_adjustment_cents > 0 ? ` (+${formatCents(oi.price_adjustment_cents)})` : ''}
                                    {oi.is_default ? ' · default' : ''}
                                  </span>
                                  {canEdit && (
                                    <button
                                      onClick={() =>
                                        run(() => supabase.from('deal_option_items').delete().eq('id', oi.id))
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
                            <div className="mt-2 flex flex-wrap gap-1.5 items-end">
                              <Select
                                value={od.item}
                                onChange={(e) =>
                                  setOptDraft((s) => ({
                                    ...s,
                                    [g.id]: { ...od, item: e.target.value, variant: '' },
                                  }))
                                }
                                className="text-[11px]"
                              >
                                <option value="">Item…</option>
                                {menu.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </Select>
                              <Select
                                value={od.variant}
                                onChange={(e) =>
                                  setOptDraft((s) => ({ ...s, [g.id]: { ...od, variant: e.target.value } }))
                                }
                                className="text-[11px]"
                              >
                                <option value="">Default variant</option>
                                {odVariants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {v.name}
                                  </option>
                                ))}
                              </Select>
                              <Input
                                type="number"
                                min="1"
                                value={od.qty}
                                onChange={(e) => setOptDraft((s) => ({ ...s, [g.id]: { ...od, qty: e.target.value } }))}
                                className="w-14 text-[11px]"
                                title="Qty"
                              />
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                value={od.price}
                                onChange={(e) => setOptDraft((s) => ({ ...s, [g.id]: { ...od, price: e.target.value } }))}
                                className="w-20 text-[11px]"
                                title="Upcharge"
                              />
                              <label className="flex items-center gap-1 text-[11px]">
                                <input
                                  type="checkbox"
                                  checked={od.isDefault}
                                  onChange={(e) =>
                                    setOptDraft((s) => ({ ...s, [g.id]: { ...od, isDefault: e.target.checked } }))
                                  }
                                />
                                default
                              </label>
                              <Button
                                variant="ghost"
                                disabled={busy || !od.item}
                                onClick={() => {
                                  const cents = Math.round(parseFloat(od.price || '0') * 100);
                                  run(() =>
                                    supabase.from('deal_option_items').insert({
                                      group_id: g.id,
                                      menu_item_id: od.item,
                                      variant_id: od.variant || null,
                                      qty: Math.max(1, parseInt(od.qty, 10) || 1),
                                      price_adjustment_cents: Math.max(0, cents),
                                      is_default: od.isDefault,
                                    }),
                                  );
                                  setOptDraft((s) => ({ ...s, [g.id]: { item: '', variant: '', qty: '1', price: '0', isDefault: false } }));
                                }}
                              >
                                Add option
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-2 flex flex-wrap gap-1.5 items-end">
                    <Input
                      placeholder="Group name (e.g. Choose Size)"
                      value={(groupDraft[d.id] ?? { name: '', min: '1', max: '1' }).name}
                      onChange={(e) =>
                        setGroupDraft((s) => ({
                          ...s,
                          [d.id]: { ...(s[d.id] ?? { name: '', min: '1', max: '1' }), name: e.target.value },
                        }))
                      }
                      className="text-xs w-48"
                    />
                    <Input
                      type="number"
                      min="0"
                      value={(groupDraft[d.id] ?? { name: '', min: '1', max: '1' }).min}
                      onChange={(e) =>
                        setGroupDraft((s) => ({
                          ...s,
                          [d.id]: { ...(s[d.id] ?? { name: '', min: '1', max: '1' }), min: e.target.value },
                        }))
                      }
                      className="w-14 text-xs"
                      title="Min select"
                    />
                    <Input
                      type="number"
                      min="0"
                      value={(groupDraft[d.id] ?? { name: '', min: '1', max: '1' }).max}
                      onChange={(e) =>
                        setGroupDraft((s) => ({
                          ...s,
                          [d.id]: { ...(s[d.id] ?? { name: '', min: '1', max: '1' }), max: e.target.value },
                        }))
                      }
                      className="w-14 text-xs"
                      title="Max select (blank = unlimited)"
                    />
                    <Button
                      variant="ghost"
                      disabled={busy || !(groupDraft[d.id]?.name ?? '').trim()}
                      onClick={() => {
                        const gd = groupDraft[d.id] ?? { name: '', min: '1', max: '1' };
                        run(() =>
                          supabase.from('deal_option_groups').insert({
                            deal_id: d.id,
                            name: gd.name.trim(),
                            min_select: Math.max(0, parseInt(gd.min, 10) || 0),
                            max_select: gd.max.trim() === '' ? null : Math.max(0, parseInt(gd.max, 10) || 0),
                          }),
                        );
                        setGroupDraft((s) => ({ ...s, [d.id]: { name: '', min: '1', max: '1' } }));
                      }}
                    >
                      Add group
                    </Button>
                  </div>
                )}
              </div>

              {canArchive && (
                <>
                  <div className="mt-3 flex gap-2 text-xs">
                    <button
                      onClick={() =>
                        run(() => supabase.rpc('set_deal_available', { p_deal_id: d.id, p_available: !d.is_available }))
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
