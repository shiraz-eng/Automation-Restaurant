import Link from 'next/link';
import { ArrowDown, ArrowRight, ArrowUp, ChevronRight, type LucideIcon } from 'lucide-react';

/**
 * The module landing-page pattern (Finance first; Kitchen, Inventory,
 * Suppliers and Staff can adopt it later): a header with the module icon, a
 * row of KPI cards, and a grid of tool tiles that open the module's existing
 * screens. Server-safe (no hooks), so a landing page stays a server component
 * and fetches its own data under the signed-in user's RLS.
 *
 * Colours: surfaces, borders and text use the semantic tokens (RULE-UI-03), so
 * a landing follows the restaurant's Brand Kit and light/dark appearance. The
 * accent palette below is decorative only (icon tiles, KPI tints) and reads on
 * both a light and a dark surface.
 */
export type ModuleAccent = 'violet' | 'blue' | 'emerald' | 'amber' | 'rose' | 'orange' | 'indigo' | 'teal' | 'fuchsia' | 'slate';

// Full class strings so Tailwind's JIT sees them.
const ACCENTS: Record<ModuleAccent, { tile: string; card: string }> = {
  violet: { tile: 'bg-gradient-to-br from-violet-500 to-purple-600 text-white', card: 'border-violet-500/25 bg-violet-500/[0.07]' },
  blue: { tile: 'bg-gradient-to-br from-blue-500 to-blue-700 text-white', card: 'border-blue-500/25 bg-blue-500/[0.07]' },
  emerald: { tile: 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white', card: 'border-emerald-500/25 bg-emerald-500/[0.07]' },
  amber: { tile: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white', card: 'border-amber-500/25 bg-amber-500/[0.07]' },
  rose: { tile: 'bg-gradient-to-br from-rose-500 to-red-600 text-white', card: 'border-rose-500/25 bg-rose-500/[0.07]' },
  orange: { tile: 'bg-gradient-to-br from-orange-400 to-orange-600 text-white', card: 'border-orange-500/25 bg-orange-500/[0.07]' },
  indigo: { tile: 'bg-gradient-to-br from-indigo-500 to-indigo-700 text-white', card: 'border-indigo-500/25 bg-indigo-500/[0.07]' },
  teal: { tile: 'bg-gradient-to-br from-teal-500 to-cyan-600 text-white', card: 'border-teal-500/25 bg-teal-500/[0.07]' },
  fuchsia: { tile: 'bg-gradient-to-br from-fuchsia-500 to-pink-600 text-white', card: 'border-fuchsia-500/25 bg-fuchsia-500/[0.07]' },
  slate: { tile: 'bg-gradient-to-br from-slate-500 to-slate-700 text-white', card: 'border-slate-500/25 bg-slate-500/[0.07]' },
};

export function accentTile(accent: ModuleAccent): string {
  return ACCENTS[accent].tile;
}

/** Shared focus ring: high contrast on any Brand Kit colour, light or dark. */
export const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-body';

export function ModuleHeader({
  icon: Icon,
  accent,
  title,
  subtitle,
  actions,
}: {
  icon: LucideIcon;
  accent: ModuleAccent;
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-4 min-w-0">
        <span className={`grid h-14 w-14 sm:h-16 sm:w-16 shrink-0 place-items-center rounded-2xl shadow-lg shadow-black/10 ${ACCENTS[accent].tile}`}>
          <Icon className="h-7 w-7 sm:h-8 sm:w-8" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-body">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
    </header>
  );
}

/** "Finance / Ledger" — the way back to a module's landing page from one of its screens. */
export function ModuleBreadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-xs">
      <ol className="flex flex-wrap items-center gap-1 text-muted">
        {items.map((item, i) => (
          <li key={item.label} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3" aria-hidden />}
            {item.href ? (
              <Link href={item.href} className={`rounded hover:text-body hover:underline ${FOCUS_RING}`}>
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-semibold text-body">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function ModuleSection({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-surface p-4 sm:p-5 ${className}`}>
      <h2 className="text-lg font-bold text-body">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export type ModuleTool = {
  key: string;
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  accent: ModuleAccent;
};

/** Registry tiles (lib/modules) → linked tiles for one restaurant, with an optional query per tile. */
export function toModuleTools(
  defs: (Pick<ModuleTool, 'key' | 'title' | 'description' | 'icon' | 'accent'> & { path: string })[],
  base: string,
  query?: (tool: { key: string; path: string }) => string,
): ModuleTool[] {
  return defs.map((d) => {
    const q = query?.(d) ?? '';
    return { key: d.key, title: d.title, description: d.description, icon: d.icon, accent: d.accent, href: `${base}${d.path ? `/${d.path}` : ''}${q ? `?${q}` : ''}` };
  });
}

export function ModuleToolGrid({ tools }: { tools: ModuleTool[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
      {tools.map((tool) => (
        <li key={tool.key}>
          <ModuleToolCard tool={tool} />
        </li>
      ))}
    </ul>
  );
}

export function ModuleToolCard({ tool }: { tool: ModuleTool }) {
  const Icon = tool.icon;
  return (
    <Link
      href={tool.href}
      className={`group flex h-full items-center gap-4 rounded-xl border border-border bg-main/40 p-3.5 sm:p-4 transition-colors hover:border-primary/50 hover:bg-main active:bg-main ${FOCUS_RING}`}
    >
      <span className={`grid h-12 w-12 sm:h-14 sm:w-14 shrink-0 place-items-center rounded-xl shadow-md shadow-black/10 ${ACCENTS[tool.accent].tile}`}>
        <Icon className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-body">{tool.title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{tool.description}</span>
      </span>
      <span
        aria-hidden
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-muted transition-colors group-hover:border-primary/50 group-hover:text-body"
      >
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export function ModuleKpiGrid({ children }: { children: React.ReactNode }) {
  return <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">{children}</section>;
}

/**
 * One KPI. `delta` is shown only when the caller has a real previous-period
 * figure to compare against (never a placeholder 0%); `goodWhenUp: false`
 * flips the colour for costs, where a rise is bad.
 */
export function ModuleKpiCard({
  icon: Icon,
  accent,
  label,
  value,
  delta,
  goodWhenUp = true,
  compareLabel,
  footnote,
  href,
  valueTone,
}: {
  icon: LucideIcon;
  accent: ModuleAccent;
  label: string;
  value: string;
  delta?: number | null;
  goodWhenUp?: boolean;
  compareLabel?: string;
  footnote?: string;
  href?: string;
  valueTone?: 'danger';
}) {
  const hasDelta = delta != null && Number.isFinite(delta);
  const better = hasDelta ? (goodWhenUp ? delta! > 0 : delta! < 0) : false;
  const body = (
    <>
      <span className={`grid h-12 w-12 sm:h-14 sm:w-14 shrink-0 place-items-center rounded-xl ${ACCENTS[accent].tile}`}>
        <Icon className="h-6 w-6 sm:h-7 sm:w-7" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-muted">{label}</span>
        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`text-xl sm:text-2xl font-black tracking-tight font-mono leading-tight break-words ${valueTone === 'danger' ? 'text-danger' : 'text-body'}`}>{value}</span>
          {hasDelta && (
            <span className={`inline-flex items-center gap-0.5 text-xs font-bold ${delta === 0 ? 'text-muted' : better ? 'text-ok' : 'text-danger'}`}>
              {delta! > 0 ? <ArrowUp className="h-3 w-3" aria-hidden /> : delta! < 0 ? <ArrowDown className="h-3 w-3" aria-hidden /> : null}
              {delta! > 0 ? '+' : delta! < 0 ? '−' : ''}
              {Math.abs(delta!)}%
              <span className="sr-only">{better ? ' (better)' : delta === 0 ? '' : ' (worse)'}</span>
            </span>
          )}
        </span>
        {(compareLabel || footnote) && (
          <span className="mt-0.5 block truncate text-[0.6875rem] text-muted" title={[footnote, compareLabel].filter(Boolean).join(' · ')}>
            {[footnote, hasDelta ? compareLabel : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </>
  );
  const className = `flex h-full items-center gap-3 sm:gap-4 rounded-2xl border p-4 transition-colors ${ACCENTS[accent].card}`;
  return href ? (
    <Link href={href} className={`${className} hover:border-primary/50 ${FOCUS_RING}`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** A KPI the viewer may see but that could not be loaded (never a made-up number). */
export function ModuleUnavailableKpi({ label, message }: { label: string; message: string }) {
  return (
    <div className="flex h-full flex-col justify-center rounded-2xl border border-dashed border-border bg-surface p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-body">Unavailable</p>
      <p className="mt-0.5 truncate text-[0.6875rem] text-muted" title={message}>
        {message}
      </p>
    </div>
  );
}

/** Placeholder blocks while a landing section streams in. */
export function ModuleSkeleton({ className }: { className: string }) {
  return <div aria-hidden className={`animate-pulse rounded-2xl border border-border bg-surface ${className}`} />;
}

/** "−12.5" style percent change, or null when there is nothing real to compare against. */
export function percentChange(now: number, prev: number | null | undefined): number | null {
  if (prev == null || prev === 0) return null;
  return Math.round(((now - prev) / Math.abs(prev)) * 1000) / 10;
}
