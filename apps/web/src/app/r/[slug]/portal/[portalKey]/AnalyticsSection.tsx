'use client';

import { useState } from 'react';
import { PerformancePanel, type Period, type CustomRange } from '../../(portal)/PerformancePanel';
import { RestaurantIntelligencePanel } from '../../(portal)/RestaurantIntelligencePanel';

/**
 * The Analytics module's real existing UI (Dashboard's own performance +
 * intelligence panels) minus the dashboard's AI box — a generated portal
 * that also grants AI Assistant already gets a full chat via AiChat, so
 * embedding AskAi here too would just duplicate that surface.
 */
export function AnalyticsSection({
  slug,
  restaurantName,
  logoUrl,
}: {
  slug: string;
  restaurantName: string;
  logoUrl?: string | null;
}) {
  const [period, setPeriod] = useState<Period>('today');
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);

  return (
    <>
      <PerformancePanel
        slug={slug}
        restaurantName={restaurantName}
        logoUrl={logoUrl}
        period={period}
        onPeriodChange={setPeriod}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
      />
      <RestaurantIntelligencePanel period={period} customRange={customRange} />
    </>
  );
}
