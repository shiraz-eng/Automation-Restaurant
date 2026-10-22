'use client';

import { usePathname } from 'next/navigation';
import { MODULES } from '@/lib/modules';
import { ModuleBreadcrumb } from '@/components/module/ModuleLanding';

/**
 * The top bar's "Module › Screen" trail, worked out from the URL and the
 * module list, so every screen links back to its module's landing page
 * without each page adding its own breadcrumb.
 */
export function ModuleTrail({ slug, fallback }: { slug: string; fallback: string }) {
  const pathname = usePathname();
  const base = `/r/${slug}`;
  const rel = pathname === base ? '' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : null;
  const items = trailFor(rel, base);
  if (!items) return <div className="font-bold text-body text-sm truncate">{fallback}</div>;
  return (
    <div className="text-sm [&_ol]:flex-nowrap [&_li]:min-w-0 [&_span]:truncate">
      <ModuleBreadcrumb items={items} />
    </div>
  );
}

function trailFor(rel: string | null, base: string): { label: string; href?: string }[] | null {
  if (rel == null) return null;
  if (rel === '') return [{ label: 'Dashboard' }];
  const landing = MODULES.find((m) => m.landing === rel);
  if (landing) return [{ label: landing.label }];

  // The screen with the longest matching path wins (menu/availability over menu).
  let best: { module: (typeof MODULES)[number]; title: string; path: string } | null = null;
  for (const m of MODULES) {
    for (const t of m.tools) {
      if (t.shared || !t.path) continue;
      if ((rel === t.path || rel.startsWith(`${t.path}/`)) && (!best || t.path.length > best.path.length)) {
        best = { module: m, title: t.title, path: t.path };
      }
    }
  }
  if (!best) return null;
  return [{ label: best.module.label, href: `${base}/${best.module.landing}` }, { label: best.title }];
}
