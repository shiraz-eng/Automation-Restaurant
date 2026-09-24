'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

type Customer = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
};
type Stats = { customer_id: string; reservations: number; last_reservation_at: string | null; no_shows: number };

const EMPTY = { name: '', phone: '', email: '', birthday: '', tags: '', notes: '' };

/**
 * Guest directory. customers.view lists guests (with visit history matched
 * from reservations by phone), customers.create adds one, customers.update
 * edits one — each its own RLS policy on public.customers (0058).
 */
export function CustomersManager({ canCreate, canUpdate }: { canCreate: boolean; canUpdate: boolean }) {
  const supabase = usePortalSupabase();
  const [rows, setRows] = useState<Customer[]>([]);
  const [stats, setStats] = useState<Map<string, Stats>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      supabase.from('customers').select('id, name, phone, email, birthday, tags, notes, created_at').order('name'),
      supabase.rpc('customer_stats'),
    ]);
    if (c.error) setError(c.error.message);
    setRows((c.data ?? []) as Customer[]);
    setStats(new Map(((s.data ?? []) as Stats[]).map((r) => [r.customer_id, r])));
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter(
      (r) => !t || [r.name, r.phone, r.email, r.tags.join(' '), r.notes].some((v) => (v ?? '').toLowerCase().includes(t)),
    );
  }, [rows, q]);

  function openNew() {
    setEditId(null);
    setForm(EMPTY);
    setShowForm(true);
  }
  function openEdit(c: Customer) {
    setEditId(c.id);
    setForm({
      name: c.name,
      phone: c.phone ?? '',
      email: c.email ?? '',
      birthday: c.birthday ?? '',
      tags: c.tags.join(', '),
      notes: c.notes ?? '',
    });
    setShowForm(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Enter the guest’s name.');
      return;
    }
    const row = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      birthday: form.birthday || null,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };
    setBusy(true);
    setError(null);
    const { error: err } = editId
      ? await supabase.from('customers').update(row).eq('id', editId)
      : await supabase.from('customers').insert(row);
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setShowForm(false);
    setForm(EMPTY);
    setEditId(null);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input placeholder="Search name, phone, email, tag…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
        {canCreate && !showForm && <Button onClick={openNew}>+ New guest</Button>}
      </div>

      {showForm && (
        <Card>
          <h3 className="font-bold text-sm mb-3">{editId ? 'Edit guest' : 'New guest'}</h3>
          <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Birthday">
              <Input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
            </Field>
            <Field label="Tags (comma separated)">
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="VIP, vegetarian" />
            </Field>
            <Field label="Notes">
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Prefers window seat" />
            </Field>
            <div className="sm:col-span-3 flex gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <p className="p-3 text-muted text-xs">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="p-3 text-muted text-xs">{rows.length === 0 ? 'No guests yet.' : 'No guest matches that search.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2.5 font-semibold">Guest</th>
                  <th className="p-2.5 font-semibold">Contact</th>
                  <th className="p-2.5 font-semibold">Tags</th>
                  <th className="p-2.5 font-semibold text-right">Bookings</th>
                  <th className="p-2.5 font-semibold">Last booking</th>
                  <th className="p-2.5" />
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const st = stats.get(c.id);
                  return (
                    <tr key={c.id} className="border-b border-border/60 last:border-0 align-top">
                      <td className="p-2.5">
                        <div className="font-semibold">{c.name}</div>
                        {c.notes && <div className="text-muted max-w-[240px]">{c.notes}</div>}
                        {c.birthday && <div className="text-muted">Birthday {c.birthday}</div>}
                      </td>
                      <td className="p-2.5 text-muted">
                        <div>{c.phone ?? '—'}</div>
                        <div>{c.email ?? ''}</div>
                      </td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-1">
                          {c.tags.map((t) => (
                            <span key={t} className="rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-bold">
                              {t}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-2.5 text-right tabular-nums">
                        {st?.reservations ?? 0}
                        {st && Number(st.no_shows) > 0 && <div className="text-danger text-[10px]">{st.no_shows} no-show</div>}
                      </td>
                      <td className="p-2.5 text-muted">{st?.last_reservation_at ? formatDateTime(st.last_reservation_at) : '—'}</td>
                      <td className="p-2.5 text-right">
                        {canUpdate && (
                          <Button variant="ghost" onClick={() => openEdit(c)}>
                            Edit
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
