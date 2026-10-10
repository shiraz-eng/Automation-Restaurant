import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { currencyInfo } from '@automation-restaurant/shared';
import { setRequestCurrency } from './format';

/**
 * The restaurant's currency for this request (get_currency(), readable by
 * anyone). Also makes it the default for formatCents() in server components
 * rendered for this request. Cached per request, so the layout and the page
 * share one lookup.
 */
export const loadTenantCurrency = cache(async (client: SupabaseClient): Promise<string> => {
  const { data } = await client.rpc('get_currency');
  const code = currencyInfo(typeof data === 'string' ? data : null).code;
  setRequestCurrency(code);
  return code;
});
