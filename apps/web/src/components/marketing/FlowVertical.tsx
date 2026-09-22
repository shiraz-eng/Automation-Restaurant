import { ArrowDown } from 'lucide-react';

export type FlowStep = { label: string; detail?: string };

/**
 * The one connected-workflow visual every "X leads to Y leads to Z" section
 * on the landing page uses (order→kitchen→inventory→finance, low-stock→PO,
 * recipe→food-cost→inventory, portal creation, the customer journey, …) —
 * a single component so every one of those diagrams reads the same way.
 */
export function FlowVertical({ steps, tone = 'default' }: { steps: FlowStep[]; tone?: 'default' | 'dark' }) {
  const dark = tone === 'dark';
  return (
    <ol className="flex flex-col items-center">
      {steps.map((step, i) => (
        <li key={step.label} className="flex flex-col items-center">
          <div
            className={`w-full min-w-[220px] max-w-sm rounded-2xl border px-5 py-3.5 text-center ${
              dark
                ? 'border-white/10 bg-white/[0.04] text-ink-fg'
                : 'border-border bg-surface shadow-sm'
            }`}
          >
            <div className={`font-display font-bold text-sm ${dark ? 'text-ink-fg' : 'text-body'}`}>{step.label}</div>
            {step.detail && (
              <div className={`text-xs mt-0.5 ${dark ? 'text-ink-muted' : 'text-muted'}`}>{step.detail}</div>
            )}
          </div>
          {i < steps.length - 1 && (
            <ArrowDown size={16} className={`my-1.5 shrink-0 ${dark ? 'text-white/25' : 'text-border'}`} strokeWidth={2.5} />
          )}
        </li>
      ))}
    </ol>
  );
}
