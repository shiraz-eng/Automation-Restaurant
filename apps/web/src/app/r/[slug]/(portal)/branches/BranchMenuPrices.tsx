'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

export type MenuRow = { id: string; name: string; menu_variants: { id: string; name: string; price_cents: number }[] };
export type OverrideRow = { branch_id: string; menu_item_id: string; variant_id: string | null; price_cents: number | null; is_available: boolean | null };

/**
 * One menu, branch prices (set_branch_menu_override, 0102): a branch can charge
 * its own price for a size, or switch a dish off. Leave the price empty to use
 * the menu price. The checkout, the guest menu and place_order all follow it.
 */
export function BranchMenuPrices({
  branches,
  items,
  overrides,
}: {
  branches: { id: string; name: string; status: string }[];
  items: MenuRow[];
  overrides: OverrideRow[];
}) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const active = branches.filter((b) => b.status !== 'archived');
  const [branchId, setBranchId] = useState(active[0]?.id ?? '');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { price: string; on: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ov = useMemo(() => {
    const m = new Map<string, OverrideRow>();
    for (const o of overrides) if (o.branch_id === branchId) m.set(`${o.menu_item_id}:${o.variant_id ?? ''}`, o);
    return m;
  }, [overrides, branchId]);

  const rows = items
    .filter((i) => !search.trim() || i.name.toLowerCase().includes(search.trim().toLowerCase()))
    .flatMap((i) => i.menu_variants.map((v) => ({ item: i, v, key: `${i.id}:${v.id}` })));

  async function save(itemId: string, variantId: string, key: string) {
    const d = drafts[key];
    if (!d) return;
    const price = d.price.trim() === '' ? null : Math.round(Number(d.price) * 100);
    if (price != null && !(price >= 0)) return setError('Enter a price, or leave it empty for the menu price.');
    setBusy(key);
    setError(null);
    const { error: e } = await supabase.rpc('set_branch_menu_override', {
      p_branch_id: branchId,
      p_menu_item_id: itemId,
      p_variant_id: variantId,
      p_price_cents: price,
      p_is_available: d.on ? null : false,
    });
    setBusy(null);
    if (e) return setError(e.message === 'forbidden' ? 'You can only change prices for your own branches.' : e.message);
    setDrafts(({ [key]: _, ...rest }) => rest);
    router.refresh();
  }

  if (active.length < 2 || items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-bold text-sm">Menu prices by branch</h2>
      <p className="text-xs text-muted">One menu for every branch. Give a branch its own price for a size, or switch a dish off there. Empty price = menu price.</p>
      <div className="flex flex-wrap gap-2">
        <Select id="menu-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label="Branch">
          {active.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Input id="menu-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dishes" className="w-56" />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-border max-h-[28rem] overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border sticky top-0 bg-surface">
            <tr>
              <th className="p-2.5 font-semibold">Dish</th>
              <th className="p-2.5 font-semibold text-right">Menu price</th>
              <th className="p-2.5 font-semibold">This branch&apos;s price</th>
              <th className="p-2.5 font-semibold">Sold here</th>
              <th className="p-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, v, key }) => {
              const o = ov.get(key) ?? ov.get(`${item.id}:`);
              const d = drafts[key] ?? { price: o?.price_cents != null ? String(o.price_cents / 100) : '', on: o?.is_available !== false };
              const changed = drafts[key] !== undefined;
              return (
                <tr key={key} className="border-b border-border/60 last:border-0">
                  <td className="p-2.5 font-semibold">
                    {item.name}
                    {item.menu_variants.length > 1 && <span className="font-normal text-muted"> · {v.name}</span>}
                  </td>
                  <td className="p-2.5 text-right font-mono text-muted">{formatCents(v.price_cents)}</td>
                  <td className="p-2.5">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      aria-label={`${item.name} ${v.name} price at this branch`}
                      value={d.price}
                      onChange={(e) => setDrafts({ ...drafts, [key]: { ...d, price: e.target.value } })}
                      placeholder="menu price"
                      className="w-28"
                    />
                  </td>
                  <td className="p-2.5">
                    <input
                      type="checkbox"
                      aria-label={`${item.name} ${v.name} sold at this branch`}
                      checked={d.on}
                      onChange={(e) => setDrafts({ ...drafts, [key]: { ...d, on: e.target.checked } })}
                    />
                  </td>
                  <td className="p-2.5 text-right">
                    {changed && (
                      <Button disabled={busy === key} onClick={() => void save(item.id, v.id, key)}>
                        Save
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
