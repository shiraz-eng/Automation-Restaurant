'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

export type Supplier = {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  created_at: string;
};

const EMPTY = {
  name: '',
  contact_name: '',
  email: '',
  phone: '',
  address: '',
  payment_terms: '',
  notes: '',
};

export function SuppliersManager({ suppliers }: { suppliers: Supplier[] }) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

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

  function startEdit(s: Supplier) {
    setEditId(s.id);
    setForm({
      name: s.name,
      contact_name: s.contact_name ?? '',
      email: s.email ?? '',
      phone: s.phone ?? '',
      address: s.address ?? '',
      payment_terms: s.payment_terms ?? '',
      notes: s.notes ?? '',
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    const row = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      payment_terms: form.payment_terms.trim() || null,
      notes: form.notes.trim() || null,
    };
    const ok = await run(() =>
      editId
        ? supabase.from('suppliers').update(row).eq('id', editId)
        : supabase.from('suppliers').insert(row),
    );
    if (ok) {
      setForm(EMPTY);
      setEditId(null);
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
        <h2 className="font-bold mb-3 text-sm">{editId ? 'Edit supplier' : 'Add supplier'}</h2>
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Contact person">
            <Input value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Payment terms">
            <Input
              value={form.payment_terms}
              onChange={(e) => set('payment_terms', e.target.value)}
              placeholder="Net 30"
            />
          </Field>
          <Field label="Address">
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <div className="sm:col-span-3 flex gap-2">
            <Button type="submit" disabled={busy}>
              {editId ? 'Save changes' : 'Add supplier'}
            </Button>
            {editId && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditId(null);
                  setForm(EMPTY);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="p-3 font-semibold">Supplier</th>
              <th className="p-3 font-semibold">Contact</th>
              <th className="p-3 font-semibold">Terms</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-3 text-muted">
                  No suppliers yet.
                </td>
              </tr>
            ) : (
              suppliers.map((s) => (
                <tr key={s.id} className="border-b border-border/60 last:border-0 align-top">
                  <td className="p-3">
                    <div className="font-semibold">{s.name}</div>
                    {s.address && <div className="text-muted">{s.address}</div>}
                  </td>
                  <td className="p-3">
                    <div>{s.contact_name ?? '—'}</div>
                    <div className="text-muted">{s.email ?? s.phone ?? ''}</div>
                  </td>
                  <td className="p-3 text-muted">{s.payment_terms ?? '—'}</td>
                  <td className="p-3 text-right whitespace-nowrap">
                    <Button variant="ghost" disabled={busy} onClick={() => startEdit(s)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      className="ml-1.5"
                      disabled={busy}
                      onClick={() =>
                        run(() => supabase.from('suppliers').delete().eq('id', s.id))
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
