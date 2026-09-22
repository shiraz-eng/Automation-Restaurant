import { Check, Receipt } from 'lucide-react';
import { Section, Eyebrow } from '@/components/marketing/Section';
import { FlowVertical } from '@/components/marketing/FlowVertical';
import { Reveal } from '@/components/marketing/Reveal';

const HIGHLIGHTS = [
  'A customer portal for ordering, order history and feedback',
  'QR/table ordering — no app install, no account required',
  'Deals and promotions surfaced right in the menu',
  'A customer AI assistant for discovery and reordering',
];

export function CustomerExperience() {
  return (
    <Section id="customer" tone="surface" width="wide">
      <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr]">
        <Reveal>
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-black/5 text-black mb-5">
            <Receipt size={20} strokeWidth={2} />
          </div>
          <Eyebrow>Customer Experience</Eyebrow>
          <h2 className="font-display text-2xl md:text-[1.85rem] font-bold tracking-tight mt-3">
            The same system, on the guest side too.
          </h2>
          <p className="text-muted mt-3 leading-relaxed">
            Customer ordering isn&rsquo;t a separate product bolted on — it writes to the same
            orders, menu and inventory data as everything else, so what a guest sees is always
            current.
          </p>
          <ul className="mt-5 space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-2.5 text-sm">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ok/10 text-ok">
                  <Check size={10} strokeWidth={3} />
                </span>
                <span className="text-body">{h}</span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={100}>
          <div className="rounded-2xl border border-border bg-main p-6 md:p-8">
            <FlowVertical
              steps={[
                { label: 'Discover' },
                { label: 'Menu' },
                { label: 'AI Assistant', detail: 'Optional — helps browse and decide' },
                { label: 'Cart' },
                { label: 'Checkout' },
                { label: 'Order' },
                { label: 'Feedback' },
                { label: 'Return', detail: 'Order history makes reordering easy' },
              ]}
            />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
