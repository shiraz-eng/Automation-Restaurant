import type { SupabaseClient } from '@supabase/supabase-js';
import { WASTE_REASON_LABELS, isWastageSchemaMissing, type WasteReason } from '@automation-restaurant/shared';
import { Card } from '@/components/ui';
import { formatCents } from '@/lib/format';
import { todayIn } from '@/lib/financePeriod';
import { WasteEntryActions, WasteEntryForm, type Member, type WasteItem } from '../../(portal)/inventory/wastage/WastageClient';

type Pending = {
  id: string;
  occurred_on: string;
  entered_qty: number;
  entered_unit: string;
  reason: string;
  note: string | null;
  status: string;
  cost_cents: number | null;
  inventory_items: { name: string } | { name: string }[] | null;
};

/**
 * Waste entry for a station (tenant-migrations/0109 + 0111): the same form and
 * approve/reject buttons as Inventory → Wastage, which a station login can't
 * open. A kitchen-only station's entries wait for approval; a station that may
 * approve also sees the waiting list. Shows nothing on a restaurant without 0111.
 */
export async function WastePortalPanel({ client, canApprove }: { client: SupabaseClient; canApprove: boolean }) {
  const [itemsRes, pendingRes, settingsRes, membersRes] = await Promise.all([
    client.rpc('waste_item_options'),
    client
      .from('waste_entries')
      .select('id, occurred_on, entered_qty, entered_unit, reason, note, status, cost_cents, inventory_items(name)')
      .eq('status', 'pending')
      .order('recorded_at', { ascending: false })
      .limit(30),
    client.from('business_settings').select('timezone').maybeSingle(),
    client.from('memberships').select('id, full_name, email').eq('status', 'active').order('full_name'),
  ]);
  if (itemsRes.error) {
    return isWastageSchemaMissing(`${itemsRes.error.code} ${itemsRes.error.message}`) ? null : (
      <Card role="alert" className="text-xs text-danger">{itemsRes.error.message}</Card>
    );
  }
  const items = ((itemsRes.data ?? []) as WasteItem[]).map((i) => ({ ...i, stock_qty: Number(i.stock_qty), min_threshold: Number(i.min_threshold) }));
  const pending = (pendingRes.data ?? []) as unknown as Pending[];
  const today = todayIn((settingsRes.data as { timezone?: string } | null)?.timezone ?? 'UTC');

  return (
    <div className="space-y-4">
      <WasteEntryForm items={items} members={(membersRes.data ?? []) as Member[]} today={today} canApprove={canApprove} />
      {pending.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-bold">Waste waiting for approval</h3>
          <ul className="divide-y divide-border/60 text-xs">
            {pending.map((e) => {
              const it = Array.isArray(e.inventory_items) ? e.inventory_items[0] : e.inventory_items;
              return (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span className="min-w-0">
                    <span className="font-semibold">{it?.name ?? '—'}</span> · {Number(e.entered_qty)} {e.entered_unit} ·{' '}
                    {WASTE_REASON_LABELS[e.reason as WasteReason] ?? e.reason} · {e.occurred_on}
                    {e.note && <span className="block text-muted">{e.note}</span>}
                  </span>
                  {canApprove ? (
                    <WasteEntryActions id={e.id} status={e.status} canApprove />
                  ) : (
                    <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[0.625rem] font-bold text-warn">
                      Waiting for approval{e.cost_cents ? ` · ${formatCents(e.cost_cents)}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
