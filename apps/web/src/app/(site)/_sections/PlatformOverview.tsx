import {
  BarChart3,
  ChefHat,
  Cog,
  Megaphone,
  Package,
  Receipt,
  Sparkles,
  Truck,
  UsersRound,
  UtensilsCrossed,
  Wallet,
} from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { ModuleCard } from '@/components/marketing/ModuleCard';
import { Reveal } from '@/components/marketing/Reveal';

const MODULES = [
  { icon: Cog, title: 'Operations', description: 'Order management, checkout and day-to-day floor operations in one place.', href: '/#operations' },
  { icon: ChefHat, title: 'Kitchen', description: 'A real-time kitchen display that turns every order into a ticket the kitchen can act on.', href: '/#operations' },
  { icon: Package, title: 'Inventory', description: 'Stock levels, movements, waste and reorder points, tracked automatically.', href: '/#inventory' },
  { icon: UtensilsCrossed, title: 'Recipes & Food Cost', description: 'Cost every dish from its ingredients and know your real margin.', href: '/#inventory' },
  { icon: Truck, title: 'Suppliers & Purchasing', description: 'Supplier records, purchase requests, orders and receiving in one workflow.', href: '/#suppliers' },
  { icon: Wallet, title: 'Finance', description: 'Revenue, expenses, supplier payments and profit — reconciled, not estimated.', href: '/#finance' },
  { icon: Megaphone, title: 'Marketing', description: 'Promotions, campaigns and customer engagement, connected to real order data.', href: '/#marketing' },
  { icon: UsersRound, title: 'Staff & Portals', description: 'Custom, permission-based portals — every team member sees exactly what they need.', href: '/#portals' },
  { icon: BarChart3, title: 'Analytics', description: 'Sales, operations, inventory and financial analytics from one connected dataset.', href: '/#connected' },
  { icon: Sparkles, title: 'AI Intelligence', description: 'Purpose-built intelligence across operations, inventory, finance and the owner view.', href: '/#ai' },
  { icon: Receipt, title: 'Customer Experience', description: 'Menu discovery, ordering, order history, feedback and a customer AI assistant.', href: '/#customer' },
];

export function PlatformOverview() {
  return (
    <Section
      id="platform"
      eyebrow="Platform"
      title="Everything your restaurant needs. Connected."
      subtitle="Every module below reads and writes the same restaurant data — an order in Operations is the same order Finance reconciles and Analytics reports on."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map((m, i) => (
          <Reveal key={m.title} delay={(i % 3) * 60}>
            <ModuleCard icon={m.icon} title={m.title} description={m.description} href={m.href} />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
