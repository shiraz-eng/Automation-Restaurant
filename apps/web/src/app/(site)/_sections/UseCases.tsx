import { Bike, Building2, Cake, Coffee, Sandwich, Soup, UtensilsCrossed, Wine } from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { Reveal } from '@/components/marketing/Reveal';

const TYPES = [
  { icon: Sandwich, title: 'Quick Service', text: 'Fast order-to-till, built for volume.' },
  { icon: Soup, title: 'Fast Casual', text: 'Counter ordering with a kitchen that keeps up.' },
  { icon: UtensilsCrossed, title: 'Full Service', text: 'Tables, reservations and a floor to manage.' },
  { icon: Coffee, title: 'Cafés & Bakeries', text: 'Quick items, recipes, and daily stock that turns over fast.' },
  { icon: Wine, title: 'Fine Dining', text: 'Precise recipes, real food cost, a polished guest experience.' },
  { icon: Bike, title: 'Food Trucks', text: 'A lean setup that still connects to inventory and finance.' },
  { icon: Cake, title: 'Bakeries', text: 'Ingredient-level recipes and batch-driven inventory.' },
  { icon: Building2, title: 'Restaurant Groups', text: 'Multiple locations, one connected operating system.' },
];

export function UseCases() {
  return (
    <Section
      eyebrow="Use cases"
      title="Built to fit how your restaurant actually runs"
      subtitle="The same connected system, configured around your kind of restaurant."
    >
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {TYPES.map((t, i) => (
          <Reveal key={t.title} delay={(i % 4) * 60}>
            <div className="rounded-2xl border border-border bg-surface p-4 h-full text-center">
              <t.icon size={20} className="mx-auto text-black" strokeWidth={2} />
              <div className="font-display font-bold text-[13px] mt-2.5">{t.title}</div>
              <p className="text-muted text-[11px] mt-1 leading-snug">{t.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
