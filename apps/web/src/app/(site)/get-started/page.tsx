import { getActivePlans } from '@/lib/plans';
import { GetStartedForm } from './GetStartedForm';

export const metadata = { title: 'Get Started' };
export const dynamic = 'force-dynamic';

export default async function GetStartedPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; cycle?: string }>;
}) {
  const sp = await searchParams;
  const plans = await getActivePlans();
  const info = plans.find((p) => p.tier === sp.plan) ?? plans.find((p) => p.tier === 'growth') ?? plans[0];
  const cycle: 'monthly' | 'annual' = sp.cycle === 'annual' ? 'annual' : 'monthly';
  const priceCents = info ? (cycle === 'annual' ? info.priceAnnualCents : info.priceMonthlyCents) : null;
  const price = priceCents == null ? null : priceCents / 100;

  return (
    <div className="mx-auto max-w-5xl px-5 py-16 grid gap-10 lg:grid-cols-[1fr_320px]">
      <div>
        <h1 className="text-2xl md:text-3xl font-black">Create your restaurant account</h1>
        <p className="text-muted text-sm mt-2 mb-8">
          Tell us about your restaurant. After payment, your workspace provisions automatically
          and your portal link is emailed to you.
        </p>
        <GetStartedForm plan={info?.tier ?? 'growth'} cycle={cycle} />
      </div>

      <aside className="lg:sticky lg:top-24 h-fit rounded-xl border border-border bg-surface p-5 text-sm">
        <div className="font-bold">{info?.name ?? 'Plan'} plan</div>
        <div className="text-muted text-xs">{info?.blurb}</div>
        <div className="my-4 border-t border-border" />
        <div className="flex justify-between">
          <span className="text-muted">Billing</span>
          <span className="font-semibold capitalize">{cycle}</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-muted">Price</span>
          <span className="font-semibold">
            {price === null ? 'Custom' : `$${price}/mo`}
          </span>
        </div>
        <div className="flex justify-between mt-3 pt-3 border-t border-border text-base font-black">
          <span>Total today</span>
          <span>
            {price === null ? '—' : cycle === 'annual' ? `$${price * 12}` : `$${price}`}
          </span>
        </div>
        <p className="text-[11px] text-muted mt-3">
          Taxes calculated at checkout where applicable. Payment is processed by a secure
          third-party provider; card details are not stored by Automation Restaurant.
        </p>
      </aside>
    </div>
  );
}
