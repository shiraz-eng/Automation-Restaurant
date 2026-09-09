'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { formatCents } from '@/lib/format';

type Category = { id: string; name: string };
type Item = {
  id: string;
  name: string;
  price_cents: number;
  is_available: boolean;
  category_id: string | null;
};

export function MenuManager({
  categories,
  items,
}: {
  categories: Category[];
  items: Item[];
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');

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

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(price) * 100);
    if (!name.trim() || Number.isNaN(cents) || cents < 0) {
      setError('Enter a name and a valid price.');
      return;
    }
    const ok = await run(() =>
      supabase.from('menu_items').insert({
        name: name.trim(),
        price_cents: cents,
        category_id: categoryId || null,
        is_available: true,
      }),
    );
    if (ok) {
      setName('');
      setPrice('');
      setCategoryId('');
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
        <h2 className="font-bold mb-3 text-sm">Add item</h2>
        <form onSubmit={addItem} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Price (USD)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>
          <Field label="Category">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">— none —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Item</th>
              <th className="p-3 font-semibold text-right">Price</th>
              <th className="p-3 font-semibold">Available</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-3 text-muted">
                  No items yet.
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id} className="border-b border-border/60">
                  <td className="p-3 font-semibold">{it.name}</td>
                  <td className="p-3 text-right font-mono">{formatCents(it.price_cents)}</td>
                  <td className="p-3">
                    <span className={it.is_available ? 'text-ok' : 'text-muted'}>
                      {it.is_available ? 'yes' : 'no'}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          supabase
                            .from('menu_items')
                            .update({ is_available: !it.is_available })
                            .eq('id', it.id),
                        )
                      }
                    >
                      {it.is_available ? 'Disable' : 'Enable'}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
