'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';

const STATUSES = [
  'pending',
  'confirmed',
  'arrived',
  'seated',
  'completed',
  'cancelled',
  'no_show',
] as const;

type Reservation = {
  id: string;
  customer_name: string;
  phone: string | null;
  party_size: number;
  reserved_at: string;
  table_label: string | null;
  occasion: string | null;
  notes: string | null;
  status: string;
};

const STATUS_TONE: Record<string, string> = {
  confirmed: 'text-ok',
  arrived: 'text-warn',
  seated: 'text-warn',
  completed: 'text-muted',
  cancelled: 'text-danger',
  no_show: 'text-danger',
  pending: 'text-body',
};

function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** `canEdit` (tables.update — reservations' RLS write key) gates creating
 *  a booking and changing its status; tables.view alone is a read-only list. */
export function ReservationsClient({
  reservations,
  canEdit = true,
}: {
  reservations: Reservation[];
  canEdit?: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [party, setParty] = useState('2');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('19:00');
  const [phone, setPhone] = useState('');
  const [table, setTable] = useState('');
  const [occasion, setOccasion] = useState('');

  const shown = reservations.filter((r) => filter === 'all' || r.status === filter);

  const grouped = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of shown) {
      const k = dayKey(r.reserved_at);
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()];
  }, [shown]);

  async function setStatus(id: string, status: string) {
    setError(null);
    const { error } = await supabase.from('reservations').update({ status }).eq('id', id);
    if (error) setError(error.message);
    else router.refresh();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const partyNum = parseInt(party, 10);
    if (!name.trim() || !date || !time || Number.isNaN(partyNum) || partyNum <= 0) {
      setError('Name, party size, date and time are required.');
      return;
    }
    const reservedAt = new Date(`${date}T${time}`);
    if (Number.isNaN(reservedAt.getTime())) {
      setError('Invalid date/time.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await supabase.from('reservations').insert({
      customer_name: name.trim(),
      party_size: partyNum,
      reserved_at: reservedAt.toISOString(),
      phone: phone.trim() || null,
      table_label: table.trim() || null,
      occasion: occasion.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setName('');
    setParty('2');
    setDate('');
    setPhone('');
    setTable('');
    setOccasion('');
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">
          {error}
        </div>
      )}

      {canEdit && (
      <Card>
        <h2 className="font-bold text-sm mb-3">New reservation</h2>
        <form onSubmit={create} className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
          <Field label="Guest name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Party">
            <Input
              type="number"
              min="1"
              value={party}
              onChange={(e) => setParty(e.target.value)}
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Table">
            <Input value={table} onChange={(e) => setTable(e.target.value)} />
          </Field>
          <Field label="Occasion">
            <Input value={occasion} onChange={(e) => setOccasion(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Add'}
          </Button>
        </form>
      </Card>
      )}

      <div className="flex items-center gap-2">
        <span className="text-muted text-xs font-semibold">Filter</span>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40">
          <option value="all">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
      </div>

      {grouped.length === 0 ? (
        <Card>No upcoming reservations.</Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-left text-xs">
            <tbody>
              {grouped.map(([day, rows]) => (
                <Fragment key={day}>
                  <tr className="bg-main/50">
                    <td colSpan={5} className="px-3 py-1.5 font-bold text-muted">
                      {day}
                    </td>
                  </tr>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/60">
                      <td className="p-3 font-mono">{timeOf(r.reserved_at)}</td>
                      <td className="p-3">
                        <div className="font-semibold">{r.customer_name}</div>
                        <div className="text-muted">
                          {r.party_size} guests
                          {r.table_label ? ` · ${r.table_label}` : ''}
                          {r.occasion ? ` · ${r.occasion}` : ''}
                        </div>
                      </td>
                      <td className="p-3 text-muted">{r.phone ?? '—'}</td>
                      <td className={`p-3 font-semibold ${STATUS_TONE[r.status] ?? ''}`}>
                        {r.status.replace('_', ' ')}
                      </td>
                      <td className="p-3 text-right">
                        {canEdit && (
                          <Select
                            value={r.status}
                            onChange={(e) => setStatus(r.id, e.target.value)}
                            className="w-32"
                          >
                            {STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s.replace('_', ' ')}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
