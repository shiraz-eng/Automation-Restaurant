import type { ComponentProps } from 'react';

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-border bg-surface p-5 ${className}`}>{children}</div>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const base = 'rounded px-3 py-1.5 text-xs font-semibold disabled:opacity-60 transition-colors';
  const variants = {
    primary: 'bg-primary text-primary-fg hover:opacity-90',
    ghost: 'border border-border hover:bg-main',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-muted text-[11px] font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function Input(props: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary ${props.className ?? ''}`}
    />
  );
}

export function Select(props: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={`w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary ${props.className ?? ''}`}
    />
  );
}
