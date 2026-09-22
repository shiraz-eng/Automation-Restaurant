import { AlertTriangle, ChefHat, ClipboardList, LayoutGrid, Package, Receipt, Sparkles, Users2 } from 'lucide-react';

const NAV_ICONS = [LayoutGrid, Receipt, ChefHat, Package, ClipboardList, Users2];

const STATS = [
  { label: 'Orders today', value: '128' },
  { label: 'Net sales', value: '$4,286' },
  { label: 'Avg. order value', value: '$33.48' },
  { label: 'Low stock', value: '3 items', warn: true },
];

const BARS = [38, 52, 44, 68, 58, 74, 61, 82, 70, 90, 64, 77];

/** A hand-built, illustrative stand-in for the real Owner Dashboard — same
 *  cards and layout the actual product shows (Orders/Net sales/AOV/Low
 *  stock, a sales trend, an AI insight), with representative rather than
 *  live numbers. Not a screenshot, so it never goes stale and never puts a
 *  real tenant's figures on the public site — inherits the live theme
 *  tokens, so it reflects the platform's actual brand color. */
export function OverviewMockup() {
  return (
    <div className="flex text-[11px] select-none">
      <div className="hidden sm:flex w-12 shrink-0 flex-col items-center gap-3 border-r border-border bg-surface/60 py-4">
        {NAV_ICONS.map((Icon, i) => (
          <div
            key={i}
            className={`grid h-8 w-8 place-items-center rounded-lg ${i === 0 ? 'bg-black text-white' : 'text-muted'}`}
          >
            <Icon size={15} />
          </div>
        ))}
      </div>
      <div className="flex-1 min-w-0 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div className="font-display font-bold text-sm text-body">Today</div>
          <div className="rounded-md bg-black/5 text-black text-[10px] font-bold px-2 py-1">Live</div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5">
          {STATS.map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-surface p-2.5">
              <div className="text-muted text-[10px]">{s.label}</div>
              <div className={`font-display font-bold text-[15px] mt-0.5 ${s.warn ? 'text-warn' : 'text-body'}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2.5 rounded-xl border border-border bg-surface p-3">
          <div className="text-muted text-[10px] mb-2">Sales — last 12 days</div>
          <div className="flex items-end gap-1.5 h-16">
            {BARS.map((h, i) => (
              <div key={i} className="flex-1 rounded-sm bg-black/70" style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>

        <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-gold/25 bg-gold/[0.06] p-2.5">
          <Sparkles size={13} className="mt-0.5 shrink-0 text-gold" />
          <div className="text-[10.5px] text-body leading-snug">
            <span className="font-semibold">Owner Intelligence:</span> Friday dinner service is trending 18% above
            last week — chicken thighs may run low before close.
          </div>
        </div>

        <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-danger/20 bg-danger/[0.05] p-2.5 text-[10.5px]">
          <AlertTriangle size={13} className="shrink-0 text-danger" />
          <span className="text-body">3 ingredients at or below reorder level — <span className="font-semibold text-black">review inventory →</span></span>
        </div>
      </div>
    </div>
  );
}
