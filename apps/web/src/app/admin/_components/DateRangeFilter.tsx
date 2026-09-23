'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const;

/** Manages a ?days= search param the server component reads to bound its query window. */
export function DateRangeFilter({ defaultDays = 30 }: { defaultDays?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = Number(searchParams.get('days') ?? defaultDays);

  function setDays(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('days', String(days));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex gap-1.5 text-xs">
      {PRESETS.map((p) => (
        <button
          key={p.days}
          onClick={() => setDays(p.days)}
          className={`px-2.5 py-1 rounded font-semibold ${current === p.days ? 'bg-gold text-ink' : 'border border-white/15 text-ink-muted hover:bg-white/5'}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
