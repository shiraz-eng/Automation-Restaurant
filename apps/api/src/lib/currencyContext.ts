import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currencyInfo, currencySymbol, formatMoney } from '@automation-restaurant/shared';

/**
 * The restaurant's currency for the current request. requirePortalPerm()
 * looks it up (get_currency()) alongside the caller check and runs the route
 * inside runWithCurrency(), so AI answers, action summaries, attention
 * messages and Excel exports all format money in it. AsyncLocalStorage keeps
 * each request's currency separate even when requests overlap.
 */
const store = new AsyncLocalStorage<{ code: string }>();

export function runWithCurrency<T>(code: string, fn: () => T): T {
  return store.run({ code: currencyInfo(code).code }, fn);
}

export function currencyCode(): string {
  return store.getStore()?.code ?? currencyInfo(null).code;
}

/** Integer hundredths → "Rs 1,250.50" in the current request's currency. */
export function money(cents: number): string {
  return formatMoney(cents, currencyCode());
}

/** Excel number format for the current currency, e.g. "Rs"#,##0.00 (4 decimals for unit costs). */
export function excelMoneyFormat(decimals = 2): string {
  const symbol = currencySymbol(currencyCode()).replace(/"/g, '');
  const n = `#,##0.${'0'.repeat(decimals)}`;
  return `"${symbol}"${n};-"${symbol}"${n}`;
}

/** A restaurant's currency code (readable by anyone; falls back to USD). */
export async function fetchCurrency(client: SupabaseClient): Promise<string> {
  try {
    const { data } = await client.rpc('get_currency');
    return currencyInfo(typeof data === 'string' ? data : null).code;
  } catch {
    return currencyInfo(null).code;
  }
}

/** One line for an AI system prompt, so the model writes amounts in this currency. */
export function currencyPromptLine(code = currencyCode()): string {
  const info = currencyInfo(code);
  return (
    `Currency: this restaurant trades in ${info.name} (${info.code}). Every *_cents amount from tools is in hundredths of ${info.code}; ` +
    `write amounts like ${formatMoney(125050, info.code)} (never "$" or another currency unless the person asks for a conversion).`
  );
}
