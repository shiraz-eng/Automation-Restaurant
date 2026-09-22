import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { Reveal } from './Reveal';
import { Eyebrow } from './Section';
import { FlowVertical, type FlowStep } from './FlowVertical';

export type WorkflowFeatureProps = {
  id?: string;
  eyebrow: string;
  icon: LucideIcon;
  title: string;
  description: string;
  highlights: string[];
  connectsWith?: string;
  flow: FlowStep[];
  /** Overrides the flow-diagram visual with a richer product mockup (e.g.
   *  wrapped in BrowserFrame) when one exists for this section. */
  visual?: ReactNode;
  reverse?: boolean;
  tone?: 'default' | 'surface';
};

/**
 * The shared template behind every "one connected workflow" deep-dive
 * (Operations & Kitchen, Inventory & Recipes, Suppliers & Purchasing,
 * Finance, Marketing) — copy + highlights on one side, the real workflow
 * as a step-flow on the other. One component so these five sections read
 * as one product, not five differently-designed pages stitched together.
 */
export function WorkflowFeature({
  id,
  eyebrow,
  icon: Icon,
  title,
  description,
  highlights,
  connectsWith,
  flow,
  visual,
  reverse = false,
  tone = 'default',
}: WorkflowFeatureProps) {
  return (
    <div id={id} className={`scroll-mt-20 ${tone === 'surface' ? 'bg-surface border-y border-border' : ''}`}>
      <div className="mx-auto max-w-6xl px-5 md:px-8 py-16 md:py-20">
        <div className={`grid items-center gap-12 lg:grid-cols-2 ${reverse ? 'lg:[&>*:first-child]:order-2' : ''}`}>
          <Reveal>
            <div className="grid h-11 w-11 place-items-center rounded-xl bg-black/5 text-black mb-5">
              <Icon size={20} strokeWidth={2} />
            </div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h3 className="font-display text-2xl md:text-[1.85rem] font-bold tracking-tight mt-3">{title}</h3>
            <p className="text-muted mt-3 leading-relaxed">{description}</p>
            <ul className="mt-5 space-y-2.5">
              {highlights.map((h) => (
                <li key={h} className="flex items-start gap-2.5 text-sm">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ok/10 text-ok">
                    <Check size={10} strokeWidth={3} />
                  </span>
                  <span className="text-body">{h}</span>
                </li>
              ))}
            </ul>
            {connectsWith && (
              <p className="mt-5 text-xs text-muted border-l-2 border-black/20 pl-3">
                <span className="font-semibold text-body">Connects with:</span> {connectsWith}
              </p>
            )}
          </Reveal>
          <Reveal delay={100}>
            {visual ?? (
              <div className="rounded-2xl border border-border bg-surface p-6 md:p-8">
                <FlowVertical steps={flow} />
              </div>
            )}
          </Reveal>
        </div>
      </div>
    </div>
  );
}
