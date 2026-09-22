import { AlertTriangle, LineChart, Package, Sparkles, Wallet } from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { BrowserFrame } from '@/components/marketing/BrowserFrame';
import { OverviewMockup } from '@/components/marketing/mockups/OverviewMockup';
import { Reveal } from '@/components/marketing/Reveal';

const POINTS = [
  { icon: LineChart, text: 'Today’s sales, orders and average order value at a glance' },
  { icon: Package, text: 'Kitchen status and low-stock alerts before they become a problem' },
  { icon: Wallet, text: 'Expenses, supplier payments and a real, reconciled profit figure' },
  { icon: AlertTriangle, text: 'A single attention list for anything that needs a decision' },
  { icon: Sparkles, text: 'AI insight surfaced next to the numbers it’s explaining' },
];

export function OwnerCommandCenter() {
  return (
    <Section
      eyebrow="Owner view"
      title="See your entire restaurant at a glance."
      subtitle="One dashboard, built from the same live data every module writes to — not a summary someone has to assemble by hand."
    >
      <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
        <Reveal>
          <BrowserFrame url="app.automationrestaurant.app/r/your-restaurant">
            <OverviewMockup />
          </BrowserFrame>
        </Reveal>
        <Reveal delay={100}>
          <ul className="space-y-4">
            {POINTS.map((p) => (
              <li key={p.text} className="flex items-start gap-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-black/5 text-black">
                  <p.icon size={16} strokeWidth={2} />
                </span>
                <span className="text-[15px] text-body pt-1.5">{p.text}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}
