'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Accessibility, X } from 'lucide-react';
import { useA11y, DEFAULT_A11Y, type A11yPrefs } from '@/lib/a11y';

const TEXT_SIZES: { value: A11yPrefs['text']; label: string }[] = [
  { value: 100, label: '100%' },
  { value: 112, label: '112%' },
  { value: 125, label: '125%' },
  { value: 150, label: '150%' },
];

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="min-w-0 text-[0.8125rem] leading-snug">
        <span className="block font-semibold text-body">{label}</span>
        <span id={`${id}-hint`} className="block text-[0.75rem] text-muted">
          {hint}
        </span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={`${id}-hint`}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
          checked ? 'border-primary bg-primary' : 'border-border bg-main'
        }`}
      >
        <span className="sr-only">{checked ? 'On' : 'Off'}</span>
        <span
          aria-hidden
          className={`inline-block h-4 w-4 rounded-full shadow transition-transform ${checked ? 'translate-x-6 bg-primary-fg' : 'translate-x-1 bg-muted'}`}
        />
      </button>
    </div>
  );
}

/** The accessibility settings themselves (used in the menu and inline in the website's phone menu). */
export function AccessibilitySettings() {
  const [p, set] = useA11y();
  const changed = JSON.stringify(p) !== JSON.stringify(DEFAULT_A11Y);
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-[0.8125rem] font-semibold text-body">Text size</legend>
        <div className="mt-1.5 grid grid-cols-4 gap-1" role="radiogroup" aria-label="Text size">
          {TEXT_SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={p.text === s.value}
              onClick={() => set({ text: s.value })}
              className={`rounded-md border px-1 py-1.5 text-[0.75rem] font-semibold ${
                p.text === s.value ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface text-body hover:bg-main'
              }`}
            >
              <span aria-hidden className="me-0.5" style={{ fontSize: `${0.6 + (s.value - 100) / 250}rem` }}>
                A
              </span>
              {s.label}
            </button>
          ))}
        </div>
      </fieldset>
      <Switch label="High contrast" hint="Darker text, stronger borders and status colours." checked={p.contrast === 'high'} onChange={(v) => set({ contrast: v ? 'high' : 'standard' })} />
      <Switch
        label="Reduce motion"
        hint="Stops animations and smooth scrolling. Your device's own setting is always followed too."
        checked={p.motion === 'reduce'}
        onChange={(v) => set({ motion: v ? 'reduce' : 'system' })}
      />
      <Switch label="Underline links" hint="Makes every link stand out without relying on colour." checked={p.underlineLinks} onChange={(v) => set({ underlineLinks: v })} />
      <Switch label="Wider text spacing" hint="More space between letters, words and lines." checked={p.spacing} onChange={(v) => set({ spacing: v })} />
      <Switch label="Larger touch targets" hint="Bigger buttons and form fields for tablets and phones." checked={p.largeTargets} onChange={(v) => set({ largeTargets: v })} />
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-[0.6875rem] text-muted">Saved on this device for every page.</p>
        {changed && (
          <button type="button" onClick={() => set(DEFAULT_A11Y)} className="rounded-md px-2 py-1 text-[0.75rem] font-semibold text-body underline underline-offset-2 hover:bg-main">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The "Accessibility" button in every header. Opens a small settings panel;
 * Escape or the close button returns focus to the button.
 */
export function AccessibilityMenu({ tone = 'light', className = '' }: { tone?: 'light' | 'dark'; className?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button, [href], input, select')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div className={`relative ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Accessibility settings"
        title="Accessibility"
        className={`grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
          tone === 'dark' ? 'border-white/15 text-ink-fg hover:bg-white/10' : 'border-border text-body hover:bg-main'
        }`}
      >
        <Accessibility size={17} aria-hidden />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-label="Accessibility settings"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
          className="absolute end-0 top-full z-[70] mt-2 w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-4 text-body shadow-2xl"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-[0.9375rem] font-bold">Accessibility</h2>
            <button type="button" onClick={close} aria-label="Close accessibility settings" className="grid h-8 w-8 place-items-center rounded-lg hover:bg-main">
              <X size={15} aria-hidden />
            </button>
          </div>
          <AccessibilitySettings />
        </div>
      )}
    </div>
  );
}
