import type { ComponentProps } from 'react';

/**
 * Admin-panel-only UI primitives — the platform's own dark/gold brand
 * identity (same --ink/--gold tokens the public marketing site already
 * uses, see globals.css + tailwind.config), deliberately separate from
 * apps/web/src/components/ui.tsx's neutral tokens, which every tenant
 * portal (a different restaurant's own Brand Kit) also renders through.
 * Restyling the shared components would have reskinned every restaurant's
 * portal by accident — this file exists so only /admin/* is affected.
 * Same prop shapes as their apps/web/src/components/ui.tsx counterparts —
 * drop-in replacements, not a different API to learn.
 */

export function AdminCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-white/10 bg-ink/60 p-5 ${className}`}>{children}</div>
  );
}

export function AdminButton({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const base = 'rounded-lg px-3.5 py-2 text-xs font-semibold disabled:opacity-50 transition-colors';
  const variants = {
    primary: 'bg-gold text-ink hover:bg-gold/90',
    ghost: 'border border-white/15 text-ink-fg hover:bg-white/5',
    danger: 'border border-red-500/40 text-red-400 hover:bg-red-500/10',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function AdminField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-ink-muted text-[11px] font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function AdminInput(props: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-white/15 bg-ink/80 px-2.5 py-1.5 text-xs text-ink-fg outline-none focus:border-gold/60 placeholder:text-ink-muted ${props.className ?? ''}`}
    />
  );
}

export function AdminTextarea(props: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-white/15 bg-ink/80 px-2.5 py-1.5 text-xs text-ink-fg outline-none focus:border-gold/60 placeholder:text-ink-muted ${props.className ?? ''}`}
    />
  );
}

export function AdminStatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
}) {
  const toneClass =
    tone === 'ok' ? 'text-emerald-400' : tone === 'warn' ? 'text-gold' : tone === 'danger' ? 'text-red-400' : 'text-ink-fg';
  return (
    <div className="rounded-xl border border-white/10 bg-ink/60 p-5">
      <div className="text-ink-muted text-xs font-semibold">{label}</div>
      <div className={`mt-2 text-2xl font-black ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  active: 'text-emerald-400 bg-emerald-400/10',
  trialing: 'text-emerald-400 bg-emerald-400/10',
  provisioning: 'text-gold bg-gold/10',
  past_due: 'text-gold bg-gold/10',
  pending: 'text-gold bg-gold/10',
  failed: 'text-red-400 bg-red-400/10',
  canceled: 'text-red-400 bg-red-400/10',
  suspended: 'text-red-400 bg-red-400/10',
};

export function AdminBadge({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? 'text-ink-muted bg-white/5';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone}`}>{status.replace('_', ' ')}</span>;
}
