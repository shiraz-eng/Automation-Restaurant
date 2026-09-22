'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PlanRow } from '@automation-restaurant/shared';

export function PricingCards({ plans }: { plans: PlanRow[] }) {
  const [annual, setAnnual] = useState(true);

  return (
    <div>
      <div className="flex items-center justify-center gap-3 mb-8 text-sm">
        <button
          onClick={() => setAnnual(false)}
          className={`px-3 py-1.5 rounded-lg font-semibold ${!annual ? 'bg-black text-white' : 'text-muted'}`}
        >
          Monthly
        </button>
        <button
          onClick={() => setAnnual(true)}
          className={`px-3 py-1.5 rounded-lg font-semibold ${annual ? 'bg-black text-white' : 'text-muted'}`}
        >
          Annual <span className="text-xs opacity-80">(save ~20%)</span>
        </button>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        {plans.map((p) => {
          const tier = p.tier;
          const priceCents = annual ? p.priceAnnualCents : p.priceMonthlyCents;
          const price = priceCents == null ? null : priceCents / 100;
          const featured = tier === 'growth';
          return (
            <div
              key={tier}
              className={`rounded-2xl border p-6 flex flex-col ${
                featured ? 'border-black shadow-lg' : 'border-border'
              } bg-surface`}
            >
              {featured && (
                <span className="self-start rounded-full bg-black/5 text-black text-[11px] font-bold px-2.5 py-0.5 mb-3">
                  Most popular
                </span>
              )}
              <h3 className="font-black text-lg">{p.name}</h3>
              <p className="text-muted text-xs mb-4">{p.blurb}</p>
              <div className="mb-4">
                {price === null ? (
                  <span className="text-2xl font-black">Custom</span>
                ) : (
                  <>
                    <span className="text-3xl font-black">${price}</span>
                    <span className="text-muted text-sm"> /mo{annual ? ', billed annually' : ''}</span>
                  </>
                )}
              </div>
              <ul className="space-y-2 text-xs mb-5 flex-1">
                {p.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span className="text-ok">✓</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
              <dl className="text-[11px] text-muted space-y-1 mb-5">
                <div className="flex justify-between">
                  <dt>Users</dt>
                  <dd className="text-body font-semibold">{p.limits.users}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Branches</dt>
                  <dd className="text-body font-semibold">{p.limits.branches}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Tables</dt>
                  <dd className="text-body font-semibold">{p.limits.tables}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Support</dt>
                  <dd className="text-body font-semibold">{p.limits.support}</dd>
                </div>
              </dl>
              {price === null ? (
                <Link
                  href="/contact"
                  className="rounded-lg border border-border text-center font-semibold py-2.5 text-sm"
                >
                  Talk to our team
                </Link>
              ) : (
                <Link
                  href={`/get-started?plan=${tier}&cycle=${annual ? 'annual' : 'monthly'}`}
                  className={`rounded-lg text-center font-semibold py-2.5 text-sm transition-transform hover:-translate-y-0.5 ${
                    featured
                      ? 'bg-black text-white'
                      : 'border border-border'
                  }`}
                >
                  Subscribe Now
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
