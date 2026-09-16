'use client';

import { useState } from 'react';
import { PerformancePanel, type Period, type CustomRange } from './PerformancePanel';
import { RestaurantIntelligencePanel } from './RestaurantIntelligencePanel';
import { AskAi } from './AskAi';

/**
 * Owns the state PerformancePanel and AskAi need to share: the selected
 * period, and (spec §1's "Custom Period") an optional custom date range
 * that overrides it. Naming a period in the AI box ("this month",
 * "yesterday" …) drives the same charts the period-selector buttons drive
 * — one source of truth for "what period is the dashboard showing", not a
 * separate AI-only view. Picking a custom range clears back to no period
 * override; picking a named period clears any custom range (both panels
 * only ever honor one at a time — see resolveRange() in PerformancePanel).
 */
export function DashboardClient({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [period, setPeriod] = useState<Period>('today');
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  return (
    <>
      <PerformancePanel
        slug={slug}
        restaurantName={restaurantName}
        period={period}
        onPeriodChange={setPeriod}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        aiSummary={aiSummary}
      />
      <RestaurantIntelligencePanel period={period} customRange={customRange} />
      <AskAi
        slug={slug}
        onPeriodDetected={(p) => {
          setCustomRange(null);
          setPeriod(p);
        }}
        onReply={setAiSummary}
      />
    </>
  );
}
