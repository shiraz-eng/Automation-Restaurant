import { cache } from 'react';
import { currencyInfo, currencySymbol, formatMoney } from '@automation-restaurant/shared';

// The restaurant's currency (business_settings.currency_code), used by every
// formatCents() call that doesn't name one.
//  • In the browser: set by <CurrencySync> in the tenant layout, so every
//    client screen, receipt and PDF built there follows it.
//  • In a server component: per request, via setRequestCurrency(), so two
//    restaurants rendering at once never see each other's currency. React's
//    cache() is scoped to one server request; outside server components it
//    just returns a fresh object, and the browser value applies.
let browserCurrency = 'USD';
const requestCurrency = cache(() => ({ code: null as string | null }));

/** Browser-side: called by <CurrencySync>. */
export function setBrowserCurrency(code: string | null | undefined) {
  browserCurrency = currencyInfo(code).code;
}

/** Server components: call once per request before formatting money. */
export function setRequestCurrency(code: string | null | undefined) {
  if (typeof window === 'undefined') requestCurrency().code = currencyInfo(code).code;
}

/** The currency formatCents() uses when none is given. */
export function activeCurrency(): string {
  if (typeof window === 'undefined') return requestCurrency().code ?? browserCurrency;
  return browserCurrency;
}

/** Integer minor units (cents) -> display string. Never do money math in floats. */
export function formatCents(cents: number, currency?: string | null): string {
  return formatMoney(cents ?? 0, currency ?? activeCurrency());
}

/** Short chart-axis label in whole units, e.g. "Rs 12,000" / "-$300". */
export function axisMoney(units: number): string {
  const sym = currencySymbol(activeCurrency());
  const n = Math.abs(units).toLocaleString(currencyInfo(activeCurrency()).locale);
  return `${units < 0 ? '-' : ''}${sym}${sym.length > 1 ? ' ' : ''}${n}`;
}

export function formatDateTime(iso: string, locale = 'en-US'): string {
  return new Date(iso).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
