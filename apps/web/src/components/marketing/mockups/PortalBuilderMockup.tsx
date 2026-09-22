import { ArrowRight, Check } from 'lucide-react';

const PERMISSIONS = ['Inventory', 'Suppliers', 'Purchasing', 'Recipes & Food Cost'];

/** Illustrative Portal Builder stand-in — individual permissions on the
 *  left, the resulting custom staff portal on the right, matching the
 *  actual permission-driven portal system (no fixed "Kitchen Portal" /
 *  "Finance Portal" bundles — the Owner picks exact permissions). */
export function PortalBuilderMockup() {
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 p-4 sm:p-6 text-[11px] select-none">
      <div className="w-full sm:w-56 shrink-0 rounded-xl border border-border bg-surface p-3.5">
        <div className="text-muted text-[10px] font-semibold mb-2">Choose permissions</div>
        <div className="space-y-1.5">
          {PERMISSIONS.map((p) => (
            <div key={p} className="flex items-center gap-2 rounded-lg bg-black/[0.04] px-2 py-1.5">
              <span className="grid h-4 w-4 shrink-0 place-items-center rounded bg-black text-white">
                <Check size={10} strokeWidth={3} />
              </span>
              <span className="text-body">{p}</span>
            </div>
          ))}
        </div>
      </div>

      <ArrowRight size={18} className="shrink-0 rotate-90 sm:rotate-0 text-border" strokeWidth={2.5} />

      <div className="w-full sm:w-56 shrink-0 rounded-xl border border-black/20 bg-black/[0.03] p-3.5">
        <div className="flex items-center justify-between mb-2">
          <span className="font-display font-bold text-body">Inventory Manager</span>
          <span className="rounded-full bg-ok/10 text-ok text-[9.5px] font-bold px-2 py-0.5">Active</span>
        </div>
        <div className="text-muted text-[10px]">Custom portal · 4 permissions</div>
        <div className="mt-2.5 h-8 rounded-lg bg-surface border border-border grid place-items-center text-muted text-[10px]">
          maya@bbq-tonight.staff
        </div>
      </div>
    </div>
  );
}
