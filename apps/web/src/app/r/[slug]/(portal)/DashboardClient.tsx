'use client';

import { useState } from 'react';
import { PerformancePanel, type Period } from './PerformancePanel';
import { AskAi } from './AskAi';

/**
 * Owns the one piece of state PerformancePanel and AskAi need to share: the
 * selected period. Naming a period in the AI box ("this month", "yesterday"
 * …) drives the same charts the period-selector buttons drive — one
 * source of truth for "what period is the dashboard showing", not a
 * separate AI-only view.
 */
export function DashboardClient({ slug, restaurantName }: { slug: string; restaurantName: string }) {
  const [period, setPeriod] = useState<Period>('today');
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  return (
    <>
      <PerformancePanel slug={slug} restaurantName={restaurantName} period={period} onPeriodChange={setPeriod} aiSummary={aiSummary} />
      <AskAi slug={slug} onPeriodDetected={setPeriod} onReply={setAiSummary} />
    </>
  );
}
