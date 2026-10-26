import { Children, cloneElement, isValidElement, useId, type ComponentProps, type ReactElement } from 'react';

export function Card({ children, className = '', ...rest }: ComponentProps<'div'>) {
  return (
    <div {...rest} className={`rounded-lg border border-border bg-surface p-5 ${className}`}>
      {children}
    </div>
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

/**
 * A labelled form control. `error` and `hint` are tied to the control
 * (aria-describedby, aria-invalid), so a screen reader reads the problem
 * with the field, and the error says what is wrong in words, not just red.
 */
export function Field({
  label,
  children,
  error,
  hint,
  labelClassName = '',
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  error?: string | null;
  hint?: string;
  /** e.g. 'sm:sr-only' — the label stays the field's accessible name even where it isn't shown. */
  labelClassName?: string;
  className?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const control =
    only && describedBy
      ? cloneElement(only, { 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })
      : children;
  return (
    <label className={`block ${className}`}>
      <span className={`text-muted text-[0.6875rem] font-semibold ${labelClassName}`}>{label}</span>
      <div className="mt-1">{control}</div>
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-[0.6875rem] text-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} role="alert" className="mt-1 block text-[0.6875rem] font-semibold text-danger">
          ⚠ {error}
        </span>
      )}
    </label>
  );
}

export function Input(props: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={`w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary aria-[invalid=true]:border-danger ${props.className ?? ''}`}
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
