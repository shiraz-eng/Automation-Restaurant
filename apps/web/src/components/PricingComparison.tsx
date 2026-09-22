import { Check, Minus } from 'lucide-react';
import type { PlanRow } from '@automation-restaurant/shared';

// The row LABELS here are marketing copy independent of any one plan's
// highlights list (a cross-tier comparison grid needs a shared taxonomy a
// flat per-tier bullet list doesn't have) — but which tiers show a check,
// and the Support row's text, are read live from the fetched plans, not
// hardcoded, so at least those two things can't drift from what's actually
// configured. starter/growth/enterprise tier keys are still assumed here;
// a plan added beyond these three won't get its own column.
type Cell = true | false | string;

function rowsFor(plans: PlanRow[]): { area: string; starter: Cell; growth: Cell; enterprise: Cell }[] {
  const by = (tier: string) => plans.find((p) => p.tier === tier);
  const support = (tier: string) => by(tier)?.limits.support ?? '—';
  return [
    { area: 'POS & order management', starter: true, growth: true, enterprise: true },
    { area: 'QR table ordering', starter: true, growth: true, enterprise: true },
    { area: 'Tables & floor', starter: true, growth: true, enterprise: true },
    { area: 'Kitchen Display (real-time)', starter: false, growth: true, enterprise: true },
    { area: 'Inventory & recipes', starter: false, growth: true, enterprise: true },
    { area: 'Staff, customers & reservations', starter: false, growth: true, enterprise: true },
    { area: 'Analytics & reports', starter: 'Basic', growth: 'Advanced', enterprise: 'Advanced' },
    { area: 'Multi-branch management', starter: false, growth: false, enterprise: true },
    { area: 'Accounting', starter: false, growth: false, enterprise: true },
    { area: 'Custom branding', starter: false, growth: false, enterprise: true },
    { area: 'Advanced permissions', starter: false, growth: false, enterprise: true },
    { area: 'Support', starter: support('starter'), growth: support('growth'), enterprise: support('enterprise') },
  ];
}

function Cell({ value }: { value: Cell }) {
  if (value === true) return <Check size={16} className="mx-auto text-ok" strokeWidth={2.5} />;
  if (value === false) return <Minus size={14} className="mx-auto text-border" strokeWidth={2.5} />;
  return <span className="text-xs font-semibold text-body">{value}</span>;
}

export function PricingComparison({ plans }: { plans: PlanRow[] }) {
  const tiers = ['starter', 'growth', 'enterprise'].map((key) => ({
    key,
    name: plans.find((p) => p.tier === key)?.name ?? key,
  }));
  const ROWS = rowsFor(plans);

  return (
    <div className="overflow-x-auto -mx-5 px-5 md:mx-0 md:px-0">
      <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            <th className="text-left font-semibold text-muted pb-3 pr-4 text-xs uppercase tracking-wide">Included</th>
            {tiers.map((t) => (
              <th key={t.key} className="text-center font-display font-bold pb-3 px-4 text-body">
                {t.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row, i) => (
            <tr key={row.area} className={i % 2 === 0 ? 'bg-surface' : ''}>
              <td className="py-3 pr-4 rounded-l-lg text-body">{row.area}</td>
              <td className="py-3 px-4 text-center rounded-none">
                <Cell value={row.starter} />
              </td>
              <td className="py-3 px-4 text-center">
                <Cell value={row.growth} />
              </td>
              <td className="py-3 px-4 text-center rounded-r-lg">
                <Cell value={row.enterprise} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-muted mt-4">
        Custom, permission-based staff portals are included on every plan.
      </p>
    </div>
  );
}
