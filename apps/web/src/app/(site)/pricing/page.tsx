import Link from 'next/link';
import { PricingCards } from '@/components/PricingCards';
import { PricingComparison } from '@/components/PricingComparison';
import { FaqAccordion } from '@/components/FaqAccordion';
import { getActivePlans } from '@/lib/plans';

export const metadata = {
  title: 'Pricing',
  description: 'Transparent, feature-gated pricing for the Automation Restaurant operating system. Compare Starter, Professional and Enterprise plans.',
};

const BILLING_FAQ = [
  {
    q: 'What happens right after I subscribe?',
    a: 'Once payment is verified, your subscription activates and your restaurant workspace is provisioned automatically. A secure portal link is emailed to your checkout address.',
  },
  {
    q: 'Can I switch between monthly and annual billing?',
    a: 'Yes — the toggle above applies to a new subscription. Annual billing is discounted versus paying monthly.',
  },
  {
    q: 'Can I upgrade my plan later?',
    a: 'Yes. Feature access updates automatically as soon as you move to a higher plan — nothing to reconfigure by hand.',
  },
  {
    q: 'Is my payment information secure?',
    a: 'Payments are processed by a secure third-party provider. Automation Restaurant never stores raw card details.',
  },
];

export default async function PricingPage() {
  const plans = await getActivePlans();
  return (
    <div>
      <div className="mx-auto max-w-6xl px-5 md:px-8 pt-16 md:pt-24 pb-12 text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-black/15 bg-black/[0.04] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-black">
          Pricing
        </span>
        <h1 className="font-display text-3xl md:text-5xl font-bold tracking-tight mt-5">
          One system, priced for how you run.
        </h1>
        <p className="text-muted mt-4 max-w-xl mx-auto text-base md:text-lg">
          Choose monthly or annual. Your restaurant workspace provisions automatically after
          checkout.
        </p>
      </div>

      <div className="mx-auto max-w-6xl px-5 md:px-8 pb-20">
        <PricingCards plans={plans} />
        <p className="text-center text-xs text-muted mt-10">
          Not sure which plan fits?{' '}
          <Link href="/contact" className="text-black font-semibold hover:underline">
            Talk to our team
          </Link>
          .
        </p>
      </div>

      <div className="border-y border-border bg-surface">
        <div className="mx-auto max-w-4xl px-5 md:px-8 py-16 md:py-20">
          <h2 className="font-display text-2xl md:text-3xl font-bold text-center tracking-tight">
            Compare every feature by plan
          </h2>
          <p className="text-muted text-center mt-2 mb-10">
            Each plan includes everything in the plan below it.
          </p>
          <PricingComparison plans={plans} />
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-5 md:px-8 py-16 md:py-20">
        <h2 className="font-display text-2xl md:text-3xl font-bold text-center tracking-tight mb-8">
          Billing questions
        </h2>
        <FaqAccordion items={BILLING_FAQ} />
      </div>
    </div>
  );
}
