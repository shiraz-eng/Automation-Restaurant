import Link from 'next/link';
import { PricingCards } from '@/components/PricingCards';

export const metadata = { title: 'Pricing — Automation Restaurant' };

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-20">
      <h1 className="text-3xl md:text-4xl font-black text-center">Pricing</h1>
      <p className="text-muted text-center mt-2 mb-10">
        Choose monthly or annual. Your restaurant workspace provisions automatically after payment.
      </p>
      <PricingCards />
      <p className="text-center text-xs text-muted mt-10">
        Not sure which plan fits?{' '}
        <Link href="/contact" className="text-primary font-semibold">
          Talk to our team
        </Link>
        .
      </p>
    </div>
  );
}
