import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  WASTE_REASON_LABELS,
  expiryRisks,
  isWastageSchemaMissing,
  parseWastageReport,
  summarizeWastage,
  wasteAlerts,
  type WasteReason,
} from '@automation-restaurant/shared';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { loadTenantCurrency } from '@/lib/currencyServer';
import { gatePortalPage, can } from '@/lib/permissions';
import { getTenantEntitlement } from '@/lib/entitlements';
import { PlanUpgradePaywall } from '@/components/PlanUpgradePaywall';
import { FinancePeriodBar } from '@/components/FinancePeriodBar';
import { StatCard } from '@/components/StatCard';
import { Card } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';
import { resolveFinancePeriod, todayIn } from '@/lib/financePeriod';
import { fromStock } from '@/lib/inventoryStock';
import { ShelfLifeEditor, WasteEntryActions, WasteEntryForm, WasteTrendChart, type Member, type WasteItem } from './WastageClient';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Wastage' };

type EntryRow = {
  id: string;
  occurred_on: string;
  recorded_at: string;
  entered_qty: number;
  entered_unit: string;
  qty_base: number;
  reason: string;
  note: string | null;
  status: string;
  cost_cents: number | null;
  already_consumed: boolean;
  decision_note: string | null;
  reversal_reason: string | null;
  inventory_items: { name: string; unit: string } | { name: string; unit: string }[] | null;
  responsible: { full_name: string | null; email: string } | { full_name: string | null; email: string }[] | null;
};
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Waiting for approval', cls: 'border-warn/40 bg-warn/10 text-warn' },
  approved: { label: 'Approved', cls: 'border-ok/40 bg-ok/10 text-ok' },
  rejected: { label: 'Rejected', cls: 'border-border text-muted' },
  reversed: { label: 'Reversed', cls: 'border-border text-muted' },
};

export default async function WastagePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  await loadTenantCurrency(t.client);

  const { role, perms } = await gatePortalPage(t.client, slug, '');
  // Same rules as app.can_approve_waste / can_record_waste / can_view_waste (tenant-migrations/0109).
  const writer = role === 'owner' || role === 'manager';
  const canApprove = writer || ['inventory.manage_waste', 'stock.adjust', 'inventory.manage'].some((k) => can(perms, role, k));
  const canRecord = canApprove || can(perms, role, 'kitchen.record_waste');
  const canView = canRecord || can(perms, role, 'stock.history') || can(perms, role, 'inventory.view_cost');
  if (!canView) redirect(`/r/${slug}`);
  const canSetShelfLife = writer || can(perms, role, 'stock.update') || can(perms, role, 'inventory.manage');

  const ent = await getTenantEntitlement(t.client, t.config.tier);
  if (!ent.isEntitled('inventory.recipe_deduction')) {
    return <PlanUpgradePaywall slug={slug} featureKey="inventory.recipe_deduction" currentTier={ent.tier} />;
  }

  const { data: settings } = await t.client.from('business_settings').select('timezone').maybeSingle();
  const tz = settings?.timezone ?? 'UTC';
  const today = todayIn(tz);
  const range = resolveFinancePeriod(sp, tz, 'month');

  const [cur, prev, entriesRes, itemsRes, shelfRes, membersRes] = await Promise.all([
    t.client.rpc('wastage_report', { p_from: range.from, p_to: range.to }),
    t.client.rpc('wastage_report', { p_from: range.prevFrom, p_to: range.prevTo }),
    t.client
      .from('waste_entries')
      .select(
        'id, occurred_on, recorded_at, entered_qty, entered_unit, qty_base, reason, note, status, cost_cents, already_consumed, decision_note, reversal_reason, inventory_items(name, unit), responsible:memberships!waste_entries_responsible_member_id_fkey(full_name, email)',
      )
      .or(`status.eq.pending,and(occurred_on.gte.${range.from},occurred_on.lte.${range.to})`)
      .order('recorded_at', { ascending: false })
      .limit(100),
    fromStock((tb) =>
      t.client.from(tb).select('id, name, unit, stock_qty, min_threshold, purchase_unit_label, purchase_unit_to_base').order('name'),
    ),
    t.client.from('inventory_shelf_life').select('inventory_item_id, shelf_life_days'),
    t.client.from('memberships').select('id, full_name, email').eq('status', 'active').order('full_name'),
  ]);

  if (cur.error && isWastageSchemaMissing(`${cur.error.code} ${cur.error.message}`)) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="text-xl font-black">Wastage</h1>
        <Card role="alert" className="border-warn/40 bg-warn/10">
          <h2 className="text-sm font-bold">Database update needed</h2>
          <p className="mt-1 text-xs text-muted">
            Wastage management needs tenant migration 0109 on this restaurant&apos;s database. Until then, waste can still be recorded from
            Inventory (− waste).
          </p>
        </Card>
      </div>
    );
  }
  if (cur.error) {
    return (
      <div className="max-w-3xl space-y-4">
        <h1 className="text-xl font-black">Wastage</h1>
        <Card role="alert" className="border-danger/40 bg-danger/10 text-xs text-danger">
          {cur.error.message}
        </Card>
      </div>
    );
  }

  const report = parseWastageReport(cur.data);
  const prevReport = prev.error ? null : parseWastageReport(prev.data);
  const s = summarizeWastage(report);
  const p = prevReport ? summarizeWastage(prevReport) : null;
  const money = (c: number | null) => (c === null ? '—' : formatCents(c));
  const alerts = wasteAlerts(s, p, { format: (c) => formatCents(c) });
  const costs = report.costs_visible;

  const items = ((itemsRes.data ?? []) as WasteItem[]).map((i) => ({ ...i, stock_qty: Number(i.stock_qty), min_threshold: Number(i.min_threshold) }));
  const shelfRows = (shelfRes.data ?? []) as { inventory_item_id: string; shelf_life_days: number }[];
  const shelf = Object.fromEntries(shelfRows.map((r) => [r.inventory_item_id, r.shelf_life_days]));
  let risks: ReturnType<typeof expiryRisks> = [];
  if (shelfRows.length) {
    const longest = Math.max(...shelfRows.map((r) => r.shelf_life_days));
    const { data: receipts } = await t.client
      .from('stock_ledger')
      .select('inventory_item_id, created_at, delta_qty')
      .eq('reason', 'restock')
      .gt('delta_qty', 0)
      .in('inventory_item_id', shelfRows.map((r) => r.inventory_item_id))
      .gte('created_at', new Date(Date.now() - (longest + 1) * 86_400_000).toISOString());
    risks = expiryRisks(
      items.map((i) => ({ ...i, shelf_life_days: shelf[i.id] ?? null })),
      (receipts ?? []) as { inventory_item_id: string; created_at: string; delta_qty: number }[],
      new Date(),
      3,
    );
  }
  const atRisk = risks.filter((r) => r.status === 'expired' || r.status === 'soon');

  const entries = (entriesRes.data ?? []) as unknown as EntryRow[];
  const pending = entries.filter((e) => e.status === 'pending');
  const history = entries.filter((e) => e.status !== 'pending');
  const members = (membersRes.data ?? []) as Member[];
  const change = s.total_waste_cost_cents !== null && p?.total_waste_cost_cents ? Math.round(((s.total_waste_cost_cents - p.total_waste_cost_cents) / p.total_waste_cost_cents) * 100) : null;
  const maxReason = Math.max(1, ...s.by_reason.map((r) => Math.abs(r.cost_cents ?? r.qty_lines)));

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-3">
        <h1 className="text-xl font-black">Wastage</h1>
        <FinancePeriodBar basePath={`/r/${slug}/inventory/wastage`} period={range.period} from={range.from} to={range.to} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Waste cost"
          value={costs ? money(s.total_waste_cost_cents) : `${s.ingredients.length} ingredient${s.ingredients.length === 1 ? '' : 's'}`}
          hint={costs ? (change === null ? range.label : `${change > 0 ? '+' : ''}${change}% vs previous period`) : 'Costs need ingredient-cost access'}
          tone={change !== null && change > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="Waste rate"
          value={s.waste_rate_pct === null ? '—' : `${s.waste_rate_pct}%`}
          hint={s.waste_rate_pct === null ? 'Nothing used or costed in this period' : 'of ingredient value used'}
          tone={s.waste_rate_pct !== null && s.waste_rate_pct >= 10 ? 'warn' : 'default'}
        />
        <StatCard label="Waiting for approval" value={pending.length} hint={canApprove ? 'Approve or reject below' : 'A manager approves these'} tone={pending.length ? 'warn' : 'default'} />
        <StatCard
          label="Unexplained (stock counts)"
          value={costs ? money(s.unexplained_variance_cents) : '—'}
          hint="Count differences — not recorded waste"
          tone={(s.unexplained_variance_cents ?? 0) < 0 ? 'warn' : 'default'}
        />
      </div>

      {alerts.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-bold">Needs attention</h2>
          <ul className="space-y-2 text-xs">
            {alerts.slice(0, 8).map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className={`mt-0.5 inline-block shrink-0 rounded border px-1.5 text-[0.625rem] font-bold uppercase ${a.severity === 'danger' ? 'border-danger/40 text-danger' : 'border-warn/40 text-warn'}`}>
                  {a.severity === 'danger' ? 'High' : 'Check'}
                </span>
                <span>{a.message}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[0.6875rem] text-muted">Fixed rules (a rise of 50% or more, a waste rate of 10% or more, 15% of deliveries going off), not a forecast.</p>
        </Card>
      )}

      {canRecord && <WasteEntryForm items={items} members={members} today={today} canApprove={canApprove} />}

      {pending.length > 0 && (
        <Card>
          <h2 className="mb-3 text-sm font-bold">Waiting for approval</h2>
          <EntryTable rows={pending} costs={costs} canApprove={canApprove} money={money} />
        </Card>
      )}

      <WasteTrendChart daily={report.daily} from={range.from} to={range.to} costsVisible={costs} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-bold">By ingredient</h2>
          {s.ingredients.length === 0 ? (
            <p className="text-xs text-muted">No waste recorded in this period.</p>
          ) : (
            <div className="overflow-x-auto" tabIndex={0} role="group" aria-label="Waste by ingredient — scroll to see more">
              <table className="w-full text-start text-xs [font-variant-numeric:tabular-nums]">
                <thead className="text-muted">
                  <tr className="border-b border-border">
                    <th className="py-2 text-start font-semibold">Ingredient</th>
                    <th className="py-2 text-end font-semibold">Wasted</th>
                    {costs && <th className="py-2 text-end font-semibold">Cost</th>}
                    <th className="py-2 text-end font-semibold">Rate</th>
                    <th className="py-2 ps-2 text-start font-semibold">Main reason</th>
                  </tr>
                </thead>
                <tbody>
                  {s.ingredients.slice(0, 15).map((i) => (
                    <tr key={i.inventory_item_id} className="border-b border-border/60 last:border-0">
                      <td className="py-2">{i.name}</td>
                      <td className="py-2 text-end whitespace-nowrap">
                        {i.waste_qty} {i.unit}
                      </td>
                      {costs && <td className="py-2 text-end whitespace-nowrap">{money(i.waste_cost_cents)}</td>}
                      <td className="py-2 text-end">{i.waste_rate_pct === null ? '—' : `${i.waste_rate_pct}%`}</td>
                      <td className="py-2 ps-2 text-muted">{i.top_reason ? (WASTE_REASON_LABELS[i.top_reason as WasteReason] ?? i.top_reason) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.cost_estimated_rows > 0 && <p className="mt-2 text-[0.6875rem] text-muted">{s.cost_estimated_rows} older movement(s) had no recorded cost; today&apos;s cost is used.</p>}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-bold">By reason</h2>
          {s.by_reason.length === 0 ? (
            <p className="text-xs text-muted">No waste recorded in this period.</p>
          ) : (
            <ul className="space-y-2.5 text-xs">
              {s.by_reason.map((r) => (
                <li key={r.reason}>
                  <div className="flex justify-between gap-2">
                    <span>{r.label}</span>
                    <span className="font-semibold [font-variant-numeric:tabular-nums]">{costs ? money(r.cost_cents) : `${r.qty_lines} ingredient${r.qty_lines === 1 ? '' : 's'}`}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-main" aria-hidden="true">
                    <div className="h-1.5 rounded-full bg-danger/70" style={{ width: `${Math.max(3, (Math.abs(r.cost_cents ?? r.qty_lines) / maxReason) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <h2 className="mb-1 text-sm font-bold">Expiring stock</h2>
        <p className="mb-3 text-xs text-muted">
          Estimated from each ingredient&apos;s shelf life and its deliveries, assuming the oldest stock is used first. Check the stock itself before discarding it.
        </p>
        {shelfRows.length === 0 ? (
          <p className="text-xs text-muted">No shelf life is set yet{canSetShelfLife ? ' — add one below to see what may expire.' : '.'}</p>
        ) : atRisk.length === 0 ? (
          <p className="text-xs text-ok">Nothing is estimated to expire in the next 3 days.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {atRisk.map((r) => (
              <li key={r.inventory_item_id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-2 last:border-0">
                <span className="font-semibold">{r.name}</span>
                <span className={r.status === 'expired' ? 'text-danger' : 'text-warn'}>
                  {r.expired_qty > 0 && `${r.expired_qty} ${r.unit} may be past its ${r.shelf_life_days}-day shelf life`}
                  {r.expired_qty > 0 && r.expiring_qty > 0 && ' · '}
                  {r.expiring_qty > 0 && `${r.expiring_qty} ${r.unit} expires in ${r.days_left === 0 ? 'under a day' : `${r.days_left} day${r.days_left === 1 ? '' : 's'}`}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {risks.some((r) => r.status === 'unknown') && (
          <p className="mt-2 text-[0.6875rem] text-muted">
            Age unknown (no delivery on record): {risks.filter((r) => r.status === 'unknown').map((r) => r.name).join(', ')}.
          </p>
        )}
        {canSetShelfLife && <ShelfLifeEditor items={items} shelf={shelf} />}
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-bold">History</h2>
        {history.length === 0 ? (
          <p className="text-xs text-muted">No waste entries in this period.</p>
        ) : (
          <EntryTable rows={history} costs={costs} canApprove={canApprove} money={money} />
        )}
        <p className="mt-2 text-[0.6875rem] text-muted">
          Reversing puts the stock back and takes the cost off Finance. Waste from the kitchen screen and older entries appear in the totals above as &ldquo;Not classified&rdquo;.
        </p>
      </Card>
    </div>
  );
}

function EntryTable({ rows, costs, canApprove, money }: { rows: EntryRow[]; costs: boolean; canApprove: boolean; money: (c: number | null) => string }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="group" aria-label="Waste entries — scroll to see more">
      <table className="w-full min-w-[40rem] text-start text-xs [font-variant-numeric:tabular-nums]">
        <thead className="text-muted">
          <tr className="border-b border-border">
            <th className="py-2 text-start font-semibold">Date</th>
            <th className="py-2 text-start font-semibold">Ingredient</th>
            <th className="py-2 text-end font-semibold">Quantity</th>
            <th className="py-2 ps-3 text-start font-semibold">Reason</th>
            <th className="py-2 text-start font-semibold">Responsible</th>
            {costs && <th className="py-2 text-end font-semibold">Cost</th>}
            <th className="py-2 ps-3 text-start font-semibold">Status</th>
            {canApprove && <th className="py-2 text-end font-semibold"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const it = one(e.inventory_items);
            const who = one(e.responsible);
            const st = STATUS[e.status] ?? { label: e.status, cls: 'border-border text-muted' };
            return (
              <tr key={e.id} className="border-b border-border/60 align-top last:border-0">
                <td className="py-2 whitespace-nowrap" title={`Recorded ${formatDateTime(e.recorded_at)}`}>
                  {e.occurred_on}
                </td>
                <td className="py-2">{it?.name ?? '—'}</td>
                <td className="py-2 text-end whitespace-nowrap">
                  {Number(e.entered_qty)} {e.entered_unit}
                </td>
                <td className="py-2 ps-3">
                  {WASTE_REASON_LABELS[e.reason as WasteReason] ?? e.reason}
                  {e.note && <div className="text-muted">{e.note}</div>}
                  {e.already_consumed && <div className="text-muted">Already used by an order — stock not deducted again</div>}
                </td>
                <td className="py-2">{who ? who.full_name || who.email : '—'}</td>
                {costs && <td className="py-2 text-end whitespace-nowrap">{e.status === 'approved' || e.status === 'reversed' ? money(e.cost_cents) : '—'}</td>}
                <td className="py-2 ps-3">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[0.625rem] font-bold ${st.cls}`}>{st.label}</span>
                  {(e.reversal_reason || (e.status === 'rejected' && e.decision_note)) && <div className="mt-1 text-muted">{e.reversal_reason || e.decision_note}</div>}
                </td>
                {canApprove && (
                  <td className="py-2 text-end">
                    <WasteEntryActions id={e.id} status={e.status} canApprove={canApprove} />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
