'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { LaneTabs } from './components/LaneTabs';
import { StationFilter } from './components/StationFilter';
import { KotCard } from './components/KotCard';
import { KotInspector } from './components/KotInspector';
import { laneOf, primaryAction, stationsForKot, type Kot, type Lane, type LineStatus, type RecipeComponentRow } from './kitchenTypes';
import { printKotTicket } from '@/lib/generateKotTicket';

const ACTIVE_STATUSES = ['pending', 'in_kitchen', 'ready'];
const SELECT =
  'id, order_number, table_label, customer_name, channel, created_at, status, customer_note, ' +
  'order_lines(id, name_snapshot, variant_name_snapshot, qty, kds_status, modifiers, customer_note, menu_item_id, menu_items(station))';

export function KdsBoard({
  slug,
  restaurantName,
  initial,
  completedToday,
  recipeComponents,
  canEdit,
  stationRoutingEntitled,
}: {
  slug: string;
  restaurantName: string;
  initial: Kot[];
  completedToday: number;
  recipeComponents: RecipeComponentRow[];
  canEdit: boolean;
  /** kds.station_routing — a frontend-only gate (unlike menu.branded, there's
   *  no single write surface here worth a DB trigger; hiding the filter and
   *  always leaving `station` at 'all' is the whole enforcement). */
  stationRoutingEntitled: boolean;
}) {
  const supabase = usePortalSupabase();
  const [kots, setKots] = useState<Kot[]>(initial);
  const [lane, setLane] = useState<Lane>('new');
  const [station, setStation] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<Set<string>>(new Set());
  const [, forceTick] = useState(0);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('orders')
      .select(SELECT)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: true });
    if (data) setKots(data as unknown as Kot[]);
  }, [supabase]);

  // Realtime — whole-board refetch on any orders/order_lines change, the
  // same proven pattern the generated Kitchen portal board already uses
  // (KitchenPortalBoard.tsx), swapped in here for what was previously
  // pure 4s polling. A 20s tick timer keeps "Waiting" timers moving
  // between refetches without a network round trip.
  useEffect(() => {
    const channel = supabase
      .channel(`kds-${slug}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_lines' }, load)
      .subscribe();
    const clock = setInterval(() => forceTick((n) => n + 1), 20000);
    const poll = setInterval(load, 30000); // belt-and-braces, matches KitchenPortalBoard
    return () => {
      supabase.removeChannel(channel);
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [supabase, slug, load]);

  const laneCounts = useMemo(() => {
    const counts: Record<Lane, number> = { new: 0, preparing: 0, ready: 0, delayed: 0, completed: completedToday };
    for (const k of kots) counts[laneOf(k)]++;
    return counts;
  }, [kots, completedToday]);

  const stations = useMemo(() => {
    const set = new Set<string>();
    for (const k of kots) for (const s of stationsForKot(k)) set.add(s);
    return [...set].sort();
  }, [kots]);

  const stationCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of kots) for (const s of stationsForKot(k)) counts[s] = (counts[s] ?? 0) + 1;
    return counts;
  }, [kots]);

  const shown = useMemo(
    () =>
      kots.filter((k) => {
        if (lane !== 'completed' && laneOf(k) !== lane) return false;
        if (station !== 'all' && !stationsForKot(k).includes(station)) return false;
        return true;
      }),
    [kots, lane, station],
  );

  async function advanceLine(lineId: string, next: LineStatus) {
    if (busyLine.has(lineId)) return;
    setBusyLine((s) => new Set(s).add(lineId));
    await supabase.rpc('kitchen_set_line_status', { p_line_id: lineId, p_status: next });
    setBusyLine((s) => {
      const n = new Set(s);
      n.delete(lineId);
      return n;
    });
    load();
  }

  async function runPrimaryAction(kot: Kot, rpc: 'kitchen_start_order' | 'kitchen_mark_ready' | 'kitchen_complete_order') {
    await supabase.rpc(rpc, { p_order_id: kot.id });
    load();
  }

  const selected = kots.find((k) => k.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <LaneTabs counts={laneCounts} active={lane} onPick={setLane} />
      {stationRoutingEntitled && <StationFilter stations={stations} counts={stationCounts} active={station} onPick={setStation} />}

      <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-5 lg:items-start">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {shown.length === 0 ? (
            <div className="col-span-full rounded-lg border border-border bg-surface p-10 text-center text-muted text-sm">
              {lane === 'completed' ? "No orders completed yet today." : 'No tickets in this lane.'}
            </div>
          ) : (
            shown.map((k) => (
              <KotCard
                key={k.id}
                kot={k}
                lane={laneOf(k)}
                selected={k.id === selectedId}
                canEdit={canEdit}
                busy={k.order_lines.some((l) => busyLine.has(l.id))}
                onAdvanceLine={(lineId, next) => advanceLine(lineId, next)}
                onPrimaryAction={() => {
                  const action = primaryAction(k);
                  if (action) runPrimaryAction(k, action.rpc);
                }}
                onSelect={() => setSelectedId(k.id === selectedId ? null : k.id)}
                onPrint={() => printKotTicket(restaurantName, k)}
              />
            ))
          )}
        </div>

        <div className="hidden lg:block mt-0">
          {selected ? (
            <div className="sticky top-6 h-[calc(100vh-8rem)]">
              <KotInspector slug={slug} kot={selected} recipeComponents={recipeComponents} onClose={() => setSelectedId(null)} />
            </div>
          ) : (
            <div className="sticky top-6 rounded-lg border border-border bg-surface p-6 text-center text-muted text-xs">
              Select a KOT to see its details.
            </div>
          )}
        </div>
      </div>

      {selected && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/50 flex items-end" onClick={() => setSelectedId(null)}>
          <div className="w-full max-h-[85vh] bg-main rounded-t-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <KotInspector slug={slug} kot={selected} recipeComponents={recipeComponents} onClose={() => setSelectedId(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
