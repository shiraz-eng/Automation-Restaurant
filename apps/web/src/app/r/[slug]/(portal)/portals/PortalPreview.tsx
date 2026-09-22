import { resolvePortalCapabilities, portalSections } from '@/lib/portalCapabilities';

/**
 * The Create/Edit Portal live preview — built from the exact same
 * permission→section mapping the generated portal itself renders from
 * (lib/portalCapabilities.ts), so this can never show access the portal
 * won't actually have. Not a mock: if a permission is missing here, the
 * real portal won't show that section either.
 */
export function PortalPreview({
  restaurantName,
  logoUrl,
  portalName,
  permissions,
}: {
  restaurantName: string;
  logoUrl?: string | null;
  portalName: string;
  permissions: Set<string>;
}) {
  const sections = portalSections(resolvePortalCapabilities([...permissions]));

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
            No permissions selected yet — this portal won&rsquo;t have anything to show when
            someone signs in.
          </p>
        ) : (
          <>
            <div className="text-[10px] font-semibold text-muted uppercase tracking-wide mb-1.5">
              Generated navigation
            </div>
            <ul className="space-y-1">
              <li className="rounded-md bg-primary/10 text-primary text-xs font-semibold px-2 py-1.5">Dashboard</li>
              {sections.map((s) => (
                <li key={s.id} className="rounded-md text-xs font-medium px-2 py-1.5 text-body border border-border/60">
                  {s.label}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
