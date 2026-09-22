import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { PricingCards } from '@/components/PricingCards';
import { getActivePlans } from '@/lib/plans';
import { getSectionContent } from '@/lib/cms/content';
import type { CopyOnlyContent } from '@/lib/cms/schemas';

const DEFAULT: CopyOnlyContent = {
  eyebrow: 'Pricing',
  title: 'Transparent, feature-gated pricing',
  subtitle: 'Pick a plan — your restaurant workspace provisions automatically after checkout.',
};

export async function PricingTeaser() {
  const [plans, result] = await Promise.all([getActivePlans(), getSectionContent('pricing-teaser', 'copy_only')]);
  if (result.state === 'hidden') return null;
  const copy = result.state === 'active' ? result.content : DEFAULT;
  return (
    <Section id="pricing" tone="surface" eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle}>
      <PricingCards plans={plans} />
      <div className="text-center mt-10">
        <Link href="/pricing" className="inline-flex items-center gap-1.5 text-sm font-semibold text-black hover:underline">
          Compare every feature by plan
          <ArrowRight size={14} />
        </Link>
      </div>
    </Section>
  );
}
