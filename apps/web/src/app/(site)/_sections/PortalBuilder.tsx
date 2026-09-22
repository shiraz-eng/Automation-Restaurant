import { Check } from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { FlowVertical } from '@/components/marketing/FlowVertical';
import { BrowserFrame } from '@/components/marketing/BrowserFrame';
import { PortalBuilderMockup } from '@/components/marketing/mockups/PortalBuilderMockup';
import { Reveal } from '@/components/marketing/Reveal';

const EXAMPLES = [
  { role: 'Counter Staff', perms: ['Orders', 'Payments', 'Customers'] },
  { role: 'Kitchen Staff', perms: ['Kitchen Display', 'Order status'] },
  { role: 'Inventory Manager', perms: ['Inventory', 'Suppliers', 'Purchasing'] },
  { role: 'Finance Team', perms: ['Revenue', 'Expenses', 'Reports'] },
];

export function PortalBuilder() {
  return (
    <Section
      id="portals"
      tone="surface"
      eyebrow="Staff & Custom Portals"
      title="Give every team member exactly what they need."
      subtitle="There's no fixed 'Kitchen Portal' or 'Finance Portal.' The Owner builds a portal from individual permissions, and each person gets a workspace scoped to exactly what they were given — nothing more."
    >
      <div className="grid items-center gap-8 lg:grid-cols-[0.85fr_1.15fr] mb-14">
        <Reveal>
          <div className="rounded-2xl border border-border bg-main p-6 md:p-8">
            <FlowVertical
              steps={[
                { label: 'Owner' },
                { label: 'Creates a portal' },
                { label: 'Chooses permissions', detail: 'Selected individually, not from a bundle' },
                { label: 'Assigns it to staff' },
                { label: 'Personalized workspace', detail: 'Each person sees exactly what they need' },
              ]}
            />
          </div>
        </Reveal>
        <Reveal delay={100}>
          <BrowserFrame url="app.automationrestaurant.app/r/your-restaurant/portals">
            <PortalBuilderMockup />
          </BrowserFrame>
        </Reveal>
      </div>

      <p className="text-center text-xs font-semibold uppercase tracking-widest text-muted mb-6">
        Example portals an Owner could build
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {EXAMPLES.map((e, i) => (
          <Reveal key={e.role} delay={i * 60}>
            <div className="rounded-2xl border border-border bg-main p-5 h-full">
              <div className="font-display font-bold text-sm">{e.role}</div>
              <ul className="mt-3 space-y-1.5">
                {e.perms.map((p) => (
                  <li key={p} className="flex items-center gap-2 text-xs text-muted">
                    <Check size={12} className="text-ok shrink-0" strokeWidth={3} />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>
      <p className="text-center text-xs text-muted mt-6 max-w-xl mx-auto">
        These are examples, not fixed roles — every portal above is built from the same set of
        individual permissions an Owner can mix, match and reassign at any time.
      </p>
    </Section>
  );
}
