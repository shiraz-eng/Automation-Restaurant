import { Section } from '@/components/marketing/Section';
import { FlowVertical } from '@/components/marketing/FlowVertical';
import { Reveal } from '@/components/marketing/Reveal';

const ORDER_FLOW = [
  { label: 'Customer places an order' },
  { label: 'Operations receives it', detail: 'Order enters the live queue' },
  { label: 'Kitchen gets the ticket', detail: 'Real-time on the Kitchen Display' },
  { label: 'Inventory records consumption', detail: 'Ingredients deduct from stock' },
  { label: 'Finance records revenue', detail: 'Sales, discounts and tax reconciled' },
  { label: 'Analytics updates', detail: 'Sales, AOV and product mix' },
  { label: 'Customer history updates', detail: 'Order shows in their account' },
  { label: 'AI can surface insight', detail: 'e.g. "Friday demand is trending up"' },
];

const REORDER_FLOW = [
  { label: 'Ingredient running low' },
  { label: 'Inventory detects it', detail: 'Stock falls at or below its reorder level' },
  { label: 'Reorder suggested', detail: 'Sized from the configured target stock' },
  { label: 'Purchase request' },
  { label: 'Approval', detail: 'Routed through the platform’s approval workflow' },
  { label: 'Purchase order sent', detail: 'To the preferred supplier' },
  { label: 'Goods received' },
  { label: 'Inventory & Finance update', detail: 'Stock and supplier payables both reconcile' },
];

export function HowItConnects() {
  return (
    <Section
      id="connected"
      tone="surface"
      eyebrow="How it connects"
      title="An operating system, not a pile of tools"
      subtitle="Two examples of what happens behind a single action — nothing here is a separate app you have to keep in sync yourself."
    >
      <div className="grid gap-10 lg:grid-cols-2">
        <Reveal>
          <div className="rounded-2xl border border-border bg-main p-6 md:p-8">
            <h3 className="font-display font-bold text-lg mb-6 text-center">When a customer orders</h3>
            <FlowVertical steps={ORDER_FLOW} />
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="rounded-2xl border border-border bg-main p-6 md:p-8">
            <h3 className="font-display font-bold text-lg mb-6 text-center">When an ingredient runs low</h3>
            <FlowVertical steps={REORDER_FLOW} />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
