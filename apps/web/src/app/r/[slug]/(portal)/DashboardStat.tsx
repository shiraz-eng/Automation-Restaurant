import Link from 'next/link';

/**
 * The Dashboard/Command Center's own stat-tile treatment — deliberately
 * separate from the shared <StatCard> (used on Finance, Live ops, the
 * admin console and kiosk portals) so restyling the owner dashboard can't
 * change how those other surfaces look. Same data shape as before, just a
 * richer presentation: a tone tile gets its own tinted surface instead of
 * only tinting the number.
 */
export function DashboardStat({
  label,
  value,
  hint,
  tone = 'default',
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  href?: string;
}) {
  const toneCls =
    tone === 'ok'
      ? 'border-ok/25 bg-ok/[0.06]'
      : tone === 'warn'
        ? 'border-warn/25 bg-warn/[0.06]'
        : tone === 'danger'
          ? 'border-danger/25 bg-danger/[0.06]'
          : 'border-border bg-surface';
  const valueCls = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-body';

  const body = (
    <>
      <div className="text-muted text-[11px] font-semibold uppercase tracking-wide">{label}</div>
      <div className={`mt-2 text-2xl font-black ${valueCls}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-muted">{hint}</div>}
    </>
  );

  const className = `rounded-xl border p-4 transition-colors ${toneCls} ${href ? 'hover:border-primary/40' : ''}`;

  if (href) {
    return (
      <Link href={href} className={className}>
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}
