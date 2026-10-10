'use client';

import { createContext, useContext } from 'react';
import { setBrowserCurrency, setRequestCurrency } from '@/lib/format';

const CurrencyContext = createContext<string>('USD');

/**
 * Makes the restaurant's currency the default for every formatCents() call
 * below it (screens, receipts, PDFs). Set during render, not in an effect, so
 * the very first paint already shows the right symbol.
 */
export function CurrencySync({ code, children }: { code: string; children: React.ReactNode }) {
  setRequestCurrency(code); // server render: per request where React scopes it
  setBrowserCurrency(code);
  return <CurrencyContext.Provider value={code}>{children}</CurrencyContext.Provider>;
}

/** The restaurant's currency code, for components that need the code itself. */
export function useCurrency(): string {
  return useContext(CurrencyContext);
}
