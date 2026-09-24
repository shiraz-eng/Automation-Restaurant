'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, TrendingUp, X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Select } from '@/components/ui';
import { DealEditor } from './DealEditor';
import {
  CHANNEL_LABEL,
  ORDER_TYPE_LABEL,
  STATUS_LABEL,
  STATUS_STYLE,
  TYPE_LABEL,
  dealStatus,
  daysLabel,
  discountPct,
  itemLabel,
  money,
  regularValue,
  timeLabel,
  validityLabel,
  type DailyPoint,
  type DealAvail,
  type DealPerf,
  type DealRow,
  type DealStatus,
  type DealType,
  type MenuPick,
} from './dealTypes';

type Tab = 'all' | DealStatus;
type SortKey = 'newest' | 'revenue' | 'usage' | 'name';

/**
 * Deals & Combos workspace: KPIs, filterable table, a details panel, 30-day
 * performance and top deals — plus the create/edit wizard (DealEditor) in
 * place of the list. Used by the Operations app and by generated portals,
 * with caps deciding which actions appear; every write is still checked by
 * RLS / RPCs server-side.
 */
export function DealsWorkspace({
  deals,
  menu,
  currency,
  caps,
  canViewCost,
}: {
  deals: DealRow[];
  menu: MenuPick[];
  currency: string;
  /** deals.create / deals.update / deals.archive */
  caps: { create: boolean; edit: boolean; archive: boolean };
  /** Any cost-visibility key — shows profitability in the editor. */
  canViewCost: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const menuById = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);

  const [perf, setPerf] = useState<Map<string, DealPerf>>(new Map());
  const [avail, setAvail] = useState<Map<string, DealAvail>>(new Map());
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | DealType>('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStats = useCallback(async () => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 29);
    from.setHours(0, 0, 0, 0);
    const [p, a, d] = await Promise.all([
      supabase.rpc('deal_performance', { p_from: from.toISOString(), p_to: to.toISOString() }),
      supabase.rpc('deal_availability'),
      supabase.rpc('deal_performance_daily', { p_from: from.toISOString(), p_to: to.toISOString() }),
    ]);
    setPerf(new Map(((p.data ?? []) as DealPerf[]).map((r) => [r.deal_id, r])));
    setAvail(new Map(((a.data ?? []) as DealAvail[]).map((r) => [r.deal_id, r])));
    setDaily((d.data ?? []) as DailyPoint[]);
  }, [supabase]);

  useEffect(() => {
    void loadStats();
    const ch = supabase
      .channel('deals-workspace')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_availability' }, () => void loadStats())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [supabase, loadStats]);

  const rows = useMemo(
    () =>
      deals.map((d) => {
        const regular = regularValue(menuById, d.deal_components, d.deal_option_groups);
        return {
          deal: d,
          status: dealStatus(d),
          regular,
          discount: discountPct(regular, d.price_cents),
          perf: perf.get(d.id),
          avail: avail.get(d.id),
          itemCount:
            d.deal_components.reduce((s, c) => s + c.qty, 0) +
            d.deal_option_groups.reduce((s, g) => s + Math.max(g.min_select, 1), 0),
        };
      }),
    [deals, menuById, perf, avail],
  );

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: rows.length, active: 0, scheduled: 0, expired: 0, draft: 0, paused: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);
  const revenue30 = rows.reduce((s, r) => s + Number(r.perf?.revenue_cents ?? 0), 0);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (tab === 'all' || r.status === tab) &&
        (!typeFilter || r.deal.deal_type === typeFilter) &&
        (!term || r.deal.name.toLowerCase().includes(term) || (r.deal.ref_code ?? '').toLowerCase().includes(term)),
    );
    const by: Record<SortKey, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      newest: (a, b) => b.deal.created_at.localeCompare(a.deal.created_at),
      revenue: (a, b) => Number(b.perf?.revenue_cents ?? 0) - Number(a.perf?.revenue_cents ?? 0),
      usage: (a, b) => Number(b.perf?.orders ?? 0) - Number(a.perf?.orders ?? 0),
      name: (a, b) => a.deal.name.localeCompare(b.deal.name),
    };
    return [...list].sort(by[sort]);
  }, [rows, tab, typeFilter, q, sort]);

  const top = useMemo(
    () => [...rows].filter((r) => Number(r.perf?.revenue_cents ?? 0) > 0).sort((a, b) => Number(b.perf!.revenue_cents) - Number(a.perf!.revenue_cents)).slice(0, 5),
    [rows],
  );
  const selected = rows.find((r) => r.deal.id === selectedId) ?? null;

  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    setMenuOpen(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    router.refresh();
    void loadStats();
  }

  async function duplicate(d: DealRow) {
    setBusy(true);
    setError(null);
    setMenuOpen(null);
    try {
      const { data, error: e } = await supabase
        .from('deals')
        .insert({
          name: `${d.name} (copy)`,
          description: d.description,
          image_url: d.image_url,
          price_cents: d.price_cents,
          deal_type: d.deal_type,
          status: 'draft',
          min_qty: d.min_qty,
          max_qty: d.max_qty,
          usage_limit: d.usage_limit,
          order_types: d.order_types,
          sales_channels: d.sales_channels,
          active_days: d.active_days,
          start_time: d.start_time,
          end_time: d.end_time,
          tagline: d.tagline,
          badge: d.badge,
          show_savings: d.show_savings,
        })
        .select('id')
        .single();
      if (e || !data) throw e ?? new Error('Could not duplicate.');
      if (d.deal_components.length) {
        const { error: ce } = await supabase.from('deal_components').insert(
          d.deal_components.map((c, i) => ({ deal_id: data.id, menu_item_id: c.menu_item_id, variant_id: c.variant_id, qty: c.qty, sort_order: i })),
        );
        if (ce) throw ce;
      }
      for (const [gi, g] of d.deal_option_groups.entries()) {
        const { data: grp, error: ge } = await supabase
          .from('deal_option_groups')
          .insert({ deal_id: data.id, name: g.name, min_select: g.min_select, max_select: g.max_select, sort_order: gi })
          .select('id')
          .single();
        if (ge || !grp) throw ge ?? new Error('Could not copy a choice group.');
        if (g.deal_option_items.length) {
          const { error: ie } = await supabase.from('deal_option_items').insert(
            g.deal_option_items.map((it, ii) => ({
              group_id: grp.id,
              menu_item_id: it.menu_item_id,
              variant_id: it.variant_id,
              qty: it.qty,
              price_adjustment_cents: it.price_adjustment_cents,
              is_default: it.is_default,
              sort_order: ii,
            })),
          );
          if (ie) throw ie;
        }
      }
      router.refresh();
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Could not duplicate the deal.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    const deal = editing.id ? deals.find((d) => d.id === editing.id) ?? null : null;
    return (
      <DealEditor
        deal={deal}
        menu={menu}
        currency={currency}
        availability={deal ? avail.get(deal.id) ?? null : null}
        canSave={deal ? caps.edit : caps.create}
        canViewCost={canViewCost}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          setEditing(null);
          setSelectedId(id);
          router.refresh();
          void loadStats();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-black">Deals &amp; Combos</h1>
          <p className="text-muted text-xs mt-1">Create, manage, schedule and track promotional offers and bundled menu items.</p>
        </div>
      </div>

      {/* KPIs */}
      <Card className="p-0">
        <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.4fr_auto] divide-y lg:divide-y-0 lg:divide-x divide-border">
          {[
            ['Active Deals', counts.active],
            ['Scheduled', counts.scheduled],
            ['Expired', counts.expired],
          ].map(([label, v]) => (
            <div key={label} className="p-4">
              <div className="text-[11px] text-muted font-semibold">{label}</div>
              <div className="text-2xl font-black tabular-nums">{v}</div>
            </div>
          ))}
          <div className="p-4">
            <div className="text-[11px] text-muted font-semibold">Revenue from Deals · 30 days</div>
            <div className="text-2xl font-black tabular-nums flex items-center gap-2">
              {money(revenue30, currency)}
              {revenue30 > 0 && <TrendingUp size={16} className="text-ok" />}
            </div>
          </div>
          {caps.create && (
            <div className="p-4 flex items-center">
              <Button onClick={() => setEditing({ id: null })} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <Plus size={14} /> Create Deal
              </Button>
            </div>
          )}
        </div>
      </Card>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}

      <div className={`grid gap-4 ${selected ? 'xl:grid-cols-[1fr_320px]' : ''}`}>
        <div className="space-y-4 min-w-0">
          <Card className="p-0 overflow-hidden">
            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
              <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search deals…"
                  className="rounded border border-border bg-surface pl-7 pr-2 py-1.5 text-xs outline-none focus:border-primary w-44"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {(['all', 'active', 'scheduled', 'expired', 'draft', 'paused'] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`rounded px-2.5 py-1 text-[11px] font-semibold ${
                      tab === t ? 'bg-main text-body border border-border' : 'text-muted hover:text-body'
                    }`}
                  >
                    {t === 'all' ? 'All' : STATUS_LABEL[t]}
                    <span className="ml-1 text-muted">{counts[t]}</span>
                  </button>
                ))}
              </div>
              <div className="ml-auto flex gap-2">
                <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as '' | DealType)} className="w-32">
                  <option value="">Deal type</option>
                  {(Object.keys(TYPE_LABEL) as DealType[]).map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
                <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="w-36">
                  <option value="newest">Newest first</option>
                  <option value="revenue">Top revenue</option>
                  <option value="usage">Most ordered</option>
                  <option value="name">Name A–Z</option>
                </Select>
              </div>
            </div>

            <div className="px-3 pt-3 text-sm font-bold">All Deals &amp; Combos</div>
            {shown.length === 0 ? (
              <p className="p-4 text-muted text-xs">
                {rows.length === 0 ? 'No deals yet — create your first combo.' : 'No deals match these filters.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted border-b border-border">
                    <tr>
                      <th className="p-2.5 font-semibold">Deal / Combo</th>
                      <th className="p-2.5 font-semibold">Type</th>
                      <th className="p-2.5 font-semibold">Items</th>
                      <th className="p-2.5 font-semibold text-right">Price</th>
                      <th className="p-2.5 font-semibold">Discount</th>
                      <th className="p-2.5 font-semibold">Validity</th>
                      <th className="p-2.5 font-semibold text-right">Usage</th>
                      <th className="p-2.5 font-semibold text-right">Revenue</th>
                      <th className="p-2.5 font-semibold">Status</th>
                      <th className="p-2.5 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => {
                      const d = r.deal;
                      const thumb = d.image_url ?? (d.deal_components[0]?.menu_item_id ? menuById.get(d.deal_components[0].menu_item_id)?.image_url : null);
                      const isSel = selectedId === d.id;
                      return (
                        <tr
                          key={d.id}
                          onClick={() => setSelectedId(isSel ? null : d.id)}
                          className={`border-b border-border/60 last:border-0 cursor-pointer ${isSel ? 'bg-primary/5' : 'hover:bg-main/50'}`}
                        >
                          <td className="p-2.5">
                            <div className="flex items-center gap-2 min-w-[160px]">
                              {thumb ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={thumb} alt="" className="h-9 w-9 rounded-md object-cover shrink-0" />
                              ) : (
                                <div className="h-9 w-9 rounded-md bg-main shrink-0" />
                              )}
                              <div className="min-w-0">
                                <div className="font-semibold truncate">{d.name}</div>
                                {d.ref_code && <div className="text-[10px] text-muted font-mono">{d.ref_code}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="p-2.5">{TYPE_LABEL[d.deal_type]}</td>
                          <td className="p-2.5 text-muted">{r.itemCount} items</td>
                          <td className="p-2.5 text-right font-semibold tabular-nums whitespace-nowrap">{money(d.price_cents, currency)}</td>
                          <td className="p-2.5">
                            {r.discount != null ? (
                              <span className="rounded bg-warn/10 text-warn px-1.5 py-0.5 text-[10px] font-bold">{r.discount}%</span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                          <td className="p-2.5 text-muted whitespace-nowrap">{validityLabel(d)}</td>
                          <td className="p-2.5 text-right tabular-nums whitespace-nowrap">{Number(r.perf?.orders ?? 0)} orders</td>
                          <td className="p-2.5 text-right tabular-nums whitespace-nowrap">{money(Number(r.perf?.revenue_cents ?? 0), currency)}</td>
                          <td className="p-2.5">
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[r.status]}`}>
                              {STATUS_LABEL[r.status]}
                            </span>
                          </td>
                          <td className="p-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="relative inline-flex gap-1">
                              <button
                                onClick={() => setMenuOpen(menuOpen === d.id ? null : d.id)}
                                className="rounded border border-border p-1 hover:bg-main"
                                aria-label={`Actions for ${d.name}`}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              <button
                                onClick={() => setSelectedId(isSel ? null : d.id)}
                                className="rounded border border-border p-1 hover:bg-main"
                                aria-label="Show details"
                              >
                                {isSel ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                              </button>
                              {menuOpen === d.id && (
                                <ActionMenu
                                  onClose={() => setMenuOpen(null)}
                                  items={[
                                    { label: caps.edit ? 'Edit' : 'View', onClick: () => setEditing({ id: d.id }) },
                                    ...(caps.create ? [{ label: 'Duplicate', onClick: () => duplicate(d) }] : []),
                                    ...(caps.archive && r.status !== 'expired'
                                      ? [
                                          d.status === 'active'
                                            ? { label: 'Pause', onClick: () => act(() => supabase.rpc('set_deal_available', { p_deal_id: d.id, p_available: false })) }
                                            : { label: d.status === 'draft' ? 'Publish' : 'Activate', onClick: () => act(() => supabase.rpc('set_deal_available', { p_deal_id: d.id, p_available: true })) },
                                        ]
                                      : []),
                                    ...(caps.archive
                                      ? [
                                          {
                                            label: 'Delete',
                                            danger: true,
                                            onClick: () => {
                                              if (confirm(`Delete "${d.name}"? Past orders keep their record.`))
                                                void act(() => supabase.from('deals').delete().eq('id', d.id));
                                            },
                                          },
                                        ]
                                      : []),
                                  ]}
                                />
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                <div>
                  <div className="text-sm font-bold">Deal Performance</div>
                  <div className="text-[11px] text-muted">Revenue from deals, last 30 days</div>
                </div>
                <div className="flex gap-4 text-right">
                  <div>
                    <div className="text-[10px] text-muted">Orders</div>
                    <div className="text-sm font-bold tabular-nums">{daily.reduce((s, p) => s + Number(p.orders), 0)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted">Revenue</div>
                    <div className="text-sm font-bold tabular-nums">{money(daily.reduce((s, p) => s + Number(p.revenue_cents), 0), currency)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted">Avg / order</div>
                    <div className="text-sm font-bold tabular-nums">
                      {(() => {
                        const o = daily.reduce((s, p) => s + Number(p.orders), 0);
                        const rv = daily.reduce((s, p) => s + Number(p.revenue_cents), 0);
                        return o ? money(Math.round(rv / o), currency) : '—';
                      })()}
                    </div>
                  </div>
                </div>
              </div>
              <PerformanceChart points={daily} currency={currency} />
            </Card>
            <Card>
              <div className="text-sm font-bold mb-2">Top Performing Deals</div>
              {top.length === 0 ? (
                <p className="text-muted text-xs">No deal sales in the last 30 days yet.</p>
              ) : (
                <ol className="space-y-1.5">
                  {top.map((r, i) => (
                    <li key={r.deal.id}>
                      <button
                        onClick={() => setSelectedId(r.deal.id)}
                        className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                          selectedId === r.deal.id ? 'bg-primary/10' : 'hover:bg-main'
                        }`}
                      >
                        <span className="w-4 text-muted font-bold">{i + 1}</span>
                        <span className="flex-1 truncate font-semibold">{r.deal.name}</span>
                        <span className="tabular-nums text-muted">{money(Number(r.perf!.revenue_cents), currency)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>
        </div>

        {selected && (
          <DealDetails
            row={selected}
            menuById={menuById}
            currency={currency}
            canEdit={caps.edit}
            canArchive={caps.archive}
            busy={busy}
            onClose={() => setSelectedId(null)}
            onEdit={() => setEditing({ id: selected.deal.id })}
            onToggle={() =>
              act(() =>
                supabase.rpc('set_deal_available', { p_deal_id: selected.deal.id, p_available: selected.deal.status !== 'active' }),
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function ActionMenu({
  items,
  onClose,
}: {
  items: { label: string; onClick: () => void; danger?: boolean }[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-8 z-20 w-36 rounded-lg border border-border bg-surface py-1 shadow-lg text-left">
      {items.map((it) => (
        <button
          key={it.label}
          onClick={it.onClick}
          className={`block w-full px-3 py-1.5 text-xs text-left hover:bg-main ${it.danger ? 'text-danger' : ''}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function DealDetails({
  row,
  menuById,
  currency,
  canEdit,
  canArchive,
  busy,
  onClose,
  onEdit,
  onToggle,
}: {
  row: {
    deal: DealRow;
    status: DealStatus;
    regular: number;
    discount: number | null;
    avail?: DealAvail;
    perf?: DealPerf;
  };
  menuById: Map<string, MenuPick>;
  currency: string;
  canEdit: boolean;
  canArchive: boolean;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const d = row.deal;
  const savings = Math.max(row.regular - d.price_cents, 0);
  const Line = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex justify-between gap-3 text-[11px]">
      <dt className="text-muted shrink-0">{k}</dt>
      <dd className="font-semibold text-right">{v}</dd>
    </div>
  );
  return (
    <Card className="p-0 overflow-hidden self-start xl:sticky xl:top-3">
      <div className="flex items-start justify-between gap-2 p-3 border-b border-border">
        <div className="min-w-0">
          <div className="font-black text-base truncate">{d.name}</div>
          {d.ref_code && <div className="text-[10px] text-muted font-mono">{d.ref_code}</div>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
          <button onClick={onClose} className="text-muted hover:text-body" aria-label="Close details">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="p-3 space-y-3 max-h-[70vh] overflow-y-auto">
        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">Deal information</div>
          <dl className="space-y-1">
            {d.description && <Line k="Description" v={<span className="font-normal">{d.description}</span>} />}
            <Line k="Type" v={TYPE_LABEL[d.deal_type]} />
            <Line k="Start date" v={d.starts_at ? new Date(d.starts_at).toLocaleDateString() : 'Immediately'} />
            <Line k="End date" v={d.ends_at ? new Date(d.ends_at).toLocaleDateString() : 'No end date'} />
            <Line k="Active days" v={d.active_days && d.active_days.length > 0 && d.active_days.length < 7 ? daysLabel(d.active_days) : 'All days'} />
            <Line k="Timing" v={d.start_time && d.end_time ? `${timeLabel(d.start_time)} – ${timeLabel(d.end_time)}` : 'All day'} />
          </dl>
        </section>
        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">Included items</div>
          <ul className="space-y-0.5 text-[11px]">
            {d.deal_components.map((c, i) => (
              <li key={i}>
                {c.qty > 1 ? `${c.qty}× ` : ''}
                {itemLabel(menuById, c.menu_item_id, c.variant_id)}
              </li>
            ))}
            {d.deal_option_groups.map((g, i) => (
              <li key={`g${i}`} className="text-muted">
                Choice: {g.name} ({g.deal_option_items.length} options)
              </li>
            ))}
          </ul>
        </section>
        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">Pricing</div>
          <dl className="space-y-1">
            <Line k="Original price" v={money(row.regular, currency)} />
            <Line k="Deal price" v={money(d.price_cents, currency)} />
            <Line k="Customer savings" v={money(savings, currency)} />
            <Line k="Discount" v={row.discount != null ? `${row.discount}%` : '—'} />
          </dl>
        </section>
        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">Availability</div>
          <div className="grid grid-cols-2 gap-1 text-[11px]">
            {(Object.keys(ORDER_TYPE_LABEL) as (keyof typeof ORDER_TYPE_LABEL)[]).map((t) => (
              <span key={t} className={d.order_types.includes(t) ? '' : 'text-muted line-through'}>
                {d.order_types.includes(t) ? '✓' : '✕'} {ORDER_TYPE_LABEL[t]}
              </span>
            ))}
            {(Object.keys(CHANNEL_LABEL) as (keyof typeof CHANNEL_LABEL)[]).map((c) => (
              <span key={c} className={d.sales_channels.includes(c) ? '' : 'text-muted line-through'}>
                {d.sales_channels.includes(c) ? '✓' : '✕'} {CHANNEL_LABEL[c]}
              </span>
            ))}
          </div>
          <dl className="space-y-1 mt-2">
            <Line
              k="Can make now"
              v={row.avail ? (row.avail.available_qty == null ? 'Not limited' : Math.floor(Number(row.avail.available_qty))) : '—'}
            />
            {row.avail?.bottleneck_name && <Line k="Bottleneck" v={row.avail.bottleneck_name} />}
          </dl>
        </section>
        <section>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">Rules</div>
          <dl className="space-y-1">
            <Line k="Min per order" v={d.min_qty} />
            <Line k="Max per order" v={d.max_qty ?? 'No limit'} />
            <Line k="Usage limit" v={d.usage_limit ?? 'Unlimited'} />
            <Line k="Last 30 days" v={`${Number(row.perf?.orders ?? 0)} orders · ${money(Number(row.perf?.revenue_cents ?? 0), currency)}`} />
          </dl>
        </section>
      </div>
      {(canEdit || canArchive) && (
        <div className="flex gap-2 p-3 border-t border-border">
          {canEdit && (
            <Button className="flex-1" onClick={onEdit}>
              Edit Deal
            </Button>
          )}
          {canArchive && row.status !== 'expired' && (
            <Button variant={d.status === 'active' ? 'danger' : 'ghost'} className="flex-1" disabled={busy} onClick={onToggle}>
              {d.status === 'active' ? 'Deactivate' : d.status === 'draft' ? 'Publish' : 'Activate'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Daily deal revenue as bars, with the order count on hover. */
function PerformanceChart({ points, currency }: { points: DailyPoint[]; currency: string }) {
  if (points.length === 0) return <p className="text-muted text-xs py-8 text-center">No data yet.</p>;
  const max = Math.max(1, ...points.map((p) => Number(p.revenue_cents)));
  const W = 600;
  const H = 150;
  const pad = { l: 44, r: 6, t: 8, b: 20 };
  const bw = (W - pad.l - pad.r) / points.length;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[480px]" role="img" aria-label="Daily deal revenue, last 30 days">
        {ticks.map((t) => {
          const y = pad.t + (H - pad.t - pad.b) * (1 - t / max);
          return (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="currentColor" className="text-border" strokeWidth={0.6} />
              <text x={pad.l - 4} y={y + 3} textAnchor="end" className="fill-current text-muted" fontSize={8}>
                {money(t, currency)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const v = Number(p.revenue_cents);
          const h = ((H - pad.t - pad.b) * v) / max;
          const x = pad.l + i * bw + bw * 0.15;
          const y = H - pad.b - h;
          const label = new Date(`${p.day}T00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return (
            <g key={p.day}>
              <rect x={x} y={y} width={bw * 0.7} height={Math.max(h, v > 0 ? 1 : 0)} rx={1.5} className="fill-current text-primary" opacity={0.85}>
                <title>{`${label}: ${money(v, currency)} · ${p.orders} orders`}</title>
              </rect>
              {(i === 0 || i === points.length - 1 || i % 5 === 0) && (
                <text x={x + bw * 0.35} y={H - 6} textAnchor="middle" className="fill-current text-muted" fontSize={8}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
