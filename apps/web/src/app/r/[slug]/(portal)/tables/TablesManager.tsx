'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

export type TableRow = {
  id: string;
  label: string;
  seats: number;
  sort_order: number;
  url: string;
  qrSvg: string;
};

export function TablesManager({ rows }: { rows: TableRow[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [label, setLabel] = useState('');
  const [seats, setSeats] = useState('4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) return setError('Table label is required.');
    setBusy(true);
    const { error } = await supabase.from('restaurant_tables').insert({
      label: label.trim(),
      seats: Number(seats) || 2,
      sort_order: rows.length + 1,
    });
    setBusy(false);
    if (error) return setError(error.message);
    setLabel('');
    setSeats('4');
    router.refresh();
  }

  async function remove(id: string) {
    await supabase.from('restaurant_tables').delete().eq('id', id);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      <Card className="print:hidden">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-sm">Add table</h2>
          <Button variant="ghost" onClick={() => window.print()}>
            Print all QR codes
          </Button>
        </div>
        <form onSubmit={add} className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
          <Field label="Label">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Table 6"
            />
          </Field>
          <Field label="Seats">
            <Input type="number" min="1" value={seats} onChange={(e) => setSeats(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            Add
          </Button>
        </form>
      </Card>

      {rows.length === 0 ? (
        <Card>No tables yet.</Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((r) => (
            <Card key={r.id} className="text-center">
              <div className="font-black">{r.label}</div>
              <div className="text-muted text-xs mb-2">{r.seats} seats</div>
              <div
                className="mx-auto w-[150px] h-[150px] [&_svg]:w-full [&_svg]:h-full"
                dangerouslySetInnerHTML={{ __html: r.qrSvg }}
              />
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="block mt-2 text-[10px] text-primary font-mono break-all"
              >
                {r.url}
              </a>
              <Button
                variant="danger"
                className="mt-2 print:hidden"
                onClick={() => remove(r.id)}
              >
                Remove
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
