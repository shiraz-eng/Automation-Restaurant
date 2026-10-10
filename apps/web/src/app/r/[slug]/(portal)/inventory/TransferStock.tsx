'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';

/**
 * Send stock from the branch being worked in to another branch
 * (transfer_stock(), 0101): the total stays the same, and it is never
 * revenue, food cost or an expense — just stock moving between locations.
 */
export function TransferStock({
  fromBranch,
  branches,
  items,
}: {
  fromBranch: { id: string; name: string };
  branches: { id: string; name: string; status: string }[];
  items: { id: string; name: string; unit: string; stock_qty: number }[];
}) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const targets = branches.filter((b) => b.id !== fromBranch.id && b.status === 'active');
  const [itemId, setItemId] = useState('');
  const [toId, setToId] = useState(targets[0]?.id ?? '');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (targets.length === 0) return null;
  const item = items.find((i) => i.id === itemId);

  async function send() {
    const n = Number(qty);
    if (!item || !toId || !(n > 0)) return setMsg({ ok: false, text: 'Choose an ingredient, a branch and an amount.' });
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc('transfer_stock', {
      p_inventory_item_id: item.id,
      p_from_branch: fromBranch.id,
      p_to_branch: toId,
      p_qty: n,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      setMsg({ ok: false, text: error.message.startsWith('not_enough_stock') ? `${fromBranch.name} doesn't have that much ${item.name}.` : error.message });
      return;
    }
    setMsg({ ok: true, text: `Sent ${n} ${item.unit} of ${item.name} to ${targets.find((b) => b.id === toId)?.name}.` });
    setQty('');
    setNote('');
    router.refresh();
  }

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="font-bold text-sm">Send stock to another branch</h2>
        <p className="text-xs text-muted">From {fromBranch.name}. The receiving branch&apos;s stock goes up by the same amount; nothing is sold or bought.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Ingredient">
          <Select id="transfer-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">Choose…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.stock_qty} {i.unit} here)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To branch">
          <Select id="transfer-to" value={toId} onChange={(e) => setToId(e.target.value)}>
            {targets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Amount${item ? ` (${item.unit})` : ''}`}>
          <Input id="transfer-qty" type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input id="transfer-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. weekend top-up" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send stock'}
        </Button>
        {msg && <span className={`text-xs ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</span>}
      </div>
    </Card>
  );
}
