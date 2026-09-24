import { Check, Lock } from 'lucide-react';
import { portalActionBreakdown } from '@/lib/portalCapabilities';
import type { PermRow } from './PortalsManager';

/**
 * The Create/Edit Portal live preview — built from the exact same
 * permission→section→action mapping the generated portal itself renders
 * from (lib/portalCapabilities.ts), so this can never show access the
 * portal won't actually have. Not a mock: every "allowed" line here is a
 * has() check the real portal page passes, every locked one is a check it
 * fails.
 */
export function PortalPreview({
  restaurantName,
  logoUrl,
  portalName,
  permissions,
  catalog,
}: {
  restaurantName: string;
  logoUrl?: string | null;
  portalName: string;
  permissions: Set<string>;
  catalog: PermRow[];
}) {
  const { sections, unused } = portalActionBreakdown([...permissions]);
  const labelOf = new Map(catalog.map((p) => [p.key, p.label]));
  const label = (k: string) => labelOf.get(k) ?? k;

  return (
    <div className="rounded-xl border border-border bg-main overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border bg-surface/60 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-danger/40" />
        <span className="h-2 w-2 rounded-full bg-warn/40" />
        <span className="h-2 w-2 rounded-full bg-ok/40" />
        <span className="ml-1 text-[10px] text-muted font-mono truncate">
          /portal/{portalName.trim() ? portalName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'your-portal'}
        </span>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
          )}
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted truncate">{restaurantName}</div>
            <div className="font-bold text-sm truncate">{portalName.trim() || 'Untitled portal'}</div>
          </div>
        </div>

        {sections.length === 0 ? (
          <p className="text-muted text-xs">
            No section unlocked yet — this portal won&rsquo;t have anything to show when someone signs in.
          </p>
        ) : (
          <div className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
            {sections.map((s) => (
              <div key={s.id} className="rounded-md border border-border/60 p-2">
                <div className="text-xs font-bold mb-1">{s.label}</div>
                <ul className="space-y-0.5">
                  {s.allowed.map((k) => (
                    <li key={k} className="flex items-center gap-1.5 text-[11px] text-body">
                      <Check size={11} className="text-ok shrink-0" />
                      {label(k)}
                    </li>
                  ))}
                  {s.restricted.map((k) => (
                    <li key={k} className="flex items-center gap-1.5 text-[11px] text-muted/70">
                      <Lock size={10} className="shrink-0" />
                      {label(k)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {unused.length > 0 && (
          <div className="mt-3 rounded-md border border-warn/40 bg-warn/5 p-2">
            <div className="text-[10px] font-bold text-warn uppercase tracking-wide mb-1">
              Selected but no effect in a portal
            </div>
            <p className="text-[10px] text-muted mb-1">
              These areas don&rsquo;t have a portal view yet, so granting them changes nothing here.
            </p>
            <ul className="text-[11px] text-muted space-y-0.5">
              {unused.map((k) => (
                <li key={k}>{label(k)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
