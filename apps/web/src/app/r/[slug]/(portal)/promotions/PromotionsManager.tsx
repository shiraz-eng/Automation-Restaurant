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
  created_at: string;
};

function describeValue(p: Promo): string {
  if (p.kind === 'percent') return `${((p.value_bps ?? 0) / 100).toFixed(p.value_bps! % 100 ? 2 : 0)}% off`;
  return `${formatCents(p.value_cents ?? 0)} off`;
}

export function PromotionsManager({ promos }: { promos: Promo[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');

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
    const row = {
      name: name.trim(),
      kind,
      value_bps: kind === 'percent' ? Math.round(n * 100) : null,
      value_cents: kind === 'fixed' ? Math.round(n * 100) : null,
      code: code.trim() ? code.trim().toUpperCase() : null,
      min_subtotal_cents: minSubtotal ? Math.round(parseFloat(minSubtotal) * 100) : 0,
      active: true,
    };
    const ok = await run(() => supabase.from('promotions').insert(row));
    if (ok) {
      setName('');
      setAmount('');
      setCode('');
      setMinSubtotal('');
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
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Promotion</th>
              <th className="p-3 font-semibold">Discount</th>
              <th className="p-3 font-semibold">Code</th>
              <th className="p-3 font-semibold text-right">Min. subtotal</th>
              <th className="p-3 font-semibold">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {promos.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-3 text-muted">
                  No promotions yet.
                </td>
              </tr>
            ) : (
              promos.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <td className="p-3 font-semibold">{p.name}</td>
                  <td className="p-3">{describeValue(p)}</td>
                  <td className="p-3 font-mono">{p.code ?? '—'}</td>
                  <td className="p-3 text-right text-muted">
                    {p.min_subtotal_cents ? formatCents(p.min_subtotal_cents) : '—'}
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
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
