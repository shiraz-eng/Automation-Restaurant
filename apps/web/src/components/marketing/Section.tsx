import type { ReactNode } from 'react';

/**
 * The one section shell every marketing block on the landing page uses, so
 * spacing/typography stays consistent instead of each section inventing its
 * own rhythm. `tone` picks the section's background from the same shared
 * theme tokens the rest of the app uses (RULE-UI-03) — never a one-off hex.
 */
export function Section({
  id,
  eyebrow,
  title,
  subtitle,
  tone = 'default',
  align = 'center',
  width = 'default',
  className = '',
  children,
}: {
  id?: string;
  eyebrow?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  tone?: 'default' | 'surface' | 'dark';
  align?: 'center' | 'left';
  width?: 'default' | 'wide' | 'narrow';
  className?: string;
  children?: ReactNode;
}) {
  const toneCls =
    tone === 'surface'
      ? 'bg-surface border-y border-border'
      : tone === 'dark'
        ? 'bg-ink text-ink-fg border-y border-black/20'
        : '';
  const widthCls = width === 'wide' ? 'max-w-7xl' : width === 'narrow' ? 'max-w-3xl' : 'max-w-6xl';

  return (
    <section id={id} className={`${toneCls} scroll-mt-20`}>
      <div className={`mx-auto ${widthCls} px-5 md:px-8 py-20 md:py-28 ${className}`}>
        {(eyebrow || title || subtitle) && (
          <div className={align === 'center' ? 'text-center max-w-2xl mx-auto mb-14' : 'max-w-2xl mb-14'}>
            {eyebrow && <Eyebrow tone={tone}>{eyebrow}</Eyebrow>}
            {title && (
              <h2 className="font-display text-3xl md:text-[2.75rem] leading-[1.1] font-bold tracking-tight mt-3">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className={`mt-4 text-base md:text-lg ${tone === 'dark' ? 'text-ink-muted' : 'text-muted'}`}>
                {subtitle}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

export function Eyebrow({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'surface' | 'dark' }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] ${
        tone === 'dark' ? 'border-gold/25 text-gold bg-gold/[0.07]' : 'border-black/15 text-black bg-black/[0.04]'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'dark' ? 'bg-gold' : 'bg-black'}`} />
      {children}
    </span>
  );
}
