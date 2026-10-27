'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Calendar, ChevronDown } from 'lucide-react';
import { FinancePeriodBar } from '@/components/FinancePeriodBar';
import type { FinancePeriod } from '@/lib/financePeriod';

/**
 * A module header's date-range button: shows the active range and opens the
 * shared FinancePeriodBar (quick periods, month stepper, custom from/to).
 * The range lives in the URL like every other Finance screen, so the server
 * re-renders the page's figures for it; the panel closes once it changes.
 */
export function ModuleRangePicker({
  basePath,
  period,
  from,
  to,
  label,
  compareLabel,
}: {
  basePath: string;
  period: FinancePeriod;
  from: string;
  to: string;
  label: string;
  compareLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const search = useSearchParams().toString();

  // A new range arrived (a preset link, the month picker or Apply): close.
  useEffect(() => setOpen(false), [search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm font-semibold text-body transition-colors hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-body"
      >
        <Calendar className="h-4 w-4 text-muted" aria-hidden />
        <span className="sr-only">Date range: </span>
        {label}
        <ChevronDown className={`h-4 w-4 text-muted transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Choose a date range"
          className="absolute start-0 lg:start-auto lg:end-0 z-30 mt-2 w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-4 shadow-2xl shadow-black/30"
        >
          <FinancePeriodBar basePath={basePath} period={period} from={from} to={to} compareLabel={compareLabel} />
        </div>
      )}
    </div>
  );
}
