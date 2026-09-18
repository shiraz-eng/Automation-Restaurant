'use client';

import { useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ReportDomain = 'suppliers' | 'purchasing' | 'inventory' | 'orders' | 'expenses';
export type SectionPeriod = 'today' | 'this_week' | 'this_month' | 'this_year' | 'last_year';
type CustomRange = { from: string; to: string };

const PERIODS: { key: SectionPeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
  { key: 'this_year', label: 'This year' },
  { key: 'last_year', label: 'Last year' },
];

/**
 * Per-section PDF/Excel export — the same "Suppliers section, its own
 * report" request applied consistently to Suppliers/Purchasing/Inventory/
 * Orders/Expenses. Deliberately its own small component, not a prop on
 * PerformancePanel, so the Dashboard itself is never touched by this
 * feature: each page that wants it drops <SectionReportButtons domain=".."
 * /> into its own header, independent of the Dashboard's period state.
 *
 * Reuses the exact same backend actions/endpoints the Dashboard's own
 * report buttons use (generate_report / export_excel_report /
 * /export/excel), just with `domain` set — never a second report-building
 * implementation. PDF generation + the section filter + permanent storage
 * all happen exactly the way PerformancePanel.tsx's own button does it.
 */
export function SectionReportButtons({
  slug,
  restaurantName,
  domain,
  label,
}: {
  slug: string;
  restaurantName: string;
  domain: ReportDomain;
  /** e.g. "Suppliers" — used in button titles and the day-picker heading. */
  label: string;
}) {
  const supabase = usePortalSupabase();
  const [period, setPeriod] = useState<SectionPeriod>('this_month');
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState<CustomRange>({ from: '', to: '' });
  const [busy, setBusy] = useState<'pdf' | 'excel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rangeArgs: Record<string, string> = customRange ? { from: customRange.from, to: customRange.to } : { period };
  const periodLabel = customRange
    ? `${customRange.from} to ${customRange.to}`
    : (PERIODS.find((p) => p.key === period)?.label ?? period);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function handlePdf() {
    setBusy('pdf');
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ slug, name: 'generate_report', args: { ...rangeArgs, domain } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.result) {
        setError(body.message ?? body.error ?? `Could not generate the ${label} report.`);
        return;
      }
      body.result.restaurantName = body.result.restaurantName || restaurantName;
      const { saveAndStoreReportPdf, REPORT_DOMAIN_SECTIONS } = await import('@/lib/generateReport');
      await saveAndStoreReportPdf(body.result, { sections: REPORT_DOMAIN_SECTIONS[domain], domain }, { supabase, auditId: body.auditId ?? null, domain });
    } catch {
      setError('Network error.');
    } finally {
      setBusy(null);
    }
  }

  async function handleExcel() {
    setBusy('excel');
    setError(null);
    try {
      const qs = new URLSearchParams({ slug, domain, ...rangeArgs });
      const res = await fetch(`${API}/api/ai/export/excel?${qs.toString()}`, { headers: await authHeader() });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message ?? `Could not export the ${label} workbook.`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-${domain}-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Network error.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border bg-main p-1">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => {
                setCustomRange(null);
                setPeriod(p.key);
              }}
              className={`px-2 py-1 rounded text-[10px] font-semibold transition-colors ${
                !customRange && period === p.key ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => {
              setCustomDraft(customRange ?? { from: '', to: '' });
              setCustomOpen((v) => !v);
            }}
            className={`px-2 py-1 rounded text-[10px] font-semibold transition-colors ${customRange ? 'bg-primary text-primary-fg' : 'text-muted hover:text-body'}`}
          >
            Date / Custom
          </button>
        </div>
        <button
          onClick={handlePdf}
          disabled={busy !== null}
          className="rounded-lg bg-primary text-primary-fg px-2.5 py-1.5 text-[10px] font-semibold disabled:opacity-50"
          title={`Generate a ${label} PDF for ${periodLabel}`}
        >
          {busy === 'pdf' ? 'Generating…' : `${label} PDF`}
        </button>
        <button
          onClick={handleExcel}
          disabled={busy !== null}
          className="rounded-lg border border-border bg-main px-2.5 py-1.5 text-[10px] font-semibold text-body hover:border-primary disabled:opacity-50"
          title={`Export ${label} to Excel for ${periodLabel}`}
        >
          {busy === 'excel' ? 'Exporting…' : `${label} Excel`}
        </button>
      </div>

      {customOpen && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-main p-2.5">
          <label className="text-[10px] text-muted flex flex-col gap-1">
            From
            <input
              type="date"
              value={customDraft.from}
              max={customDraft.to || undefined}
              onChange={(e) => setCustomDraft((d) => ({ ...d, from: e.target.value }))}
              className="rounded border border-border bg-surface px-2 py-1 text-[11px]"
            />
          </label>
          <label className="text-[10px] text-muted flex flex-col gap-1">
            To
            <input
              type="date"
              value={customDraft.to}
              min={customDraft.from || undefined}
              onChange={(e) => setCustomDraft((d) => ({ ...d, to: e.target.value }))}
              className="rounded border border-border bg-surface px-2 py-1 text-[11px]"
            />
          </label>
          <button
            onClick={() => {
              if (!customDraft.from || !customDraft.to) return;
              setCustomRange(customDraft);
              setCustomOpen(false);
            }}
            disabled={!customDraft.from || !customDraft.to}
            className="rounded-lg bg-primary text-primary-fg px-2.5 py-1.5 text-[10px] font-semibold disabled:opacity-50"
          >
            Apply
          </button>
          {customRange && (
            <button
              onClick={() => {
                setCustomRange(null);
                setCustomOpen(false);
              }}
              className="rounded-lg border border-border px-2.5 py-1.5 text-[10px] font-semibold text-muted hover:text-body"
            >
              Clear
            </button>
          )}
        </div>
      )}
      {error && <p className="text-danger text-[11px]">{error}</p>}
    </div>
  );
}
