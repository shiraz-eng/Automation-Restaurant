import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Read ingredient stock as the branch in view sees it (tenant-migrations/0106): the
 * `inventory_stock` view gives a branch login its own branch's stock and the owner the
 * selected branch's (or the total on "All branches"). A restaurant without 0106 falls
 * back to inventory_items. `build` gets the table name and returns the query:
 *
 *   fromStock((t) => admin.from(t).select('name, stock_qty').order('name'))
 */
export async function fromStock<T>(
  build: (table: 'inventory_stock' | 'inventory_items') => PromiseLike<{ data: T | null; error: PostgrestError | null }>,
): Promise<{ data: T | null; error: PostgrestError | null }> {
  const r = await build('inventory_stock');
  if (r.error && /inventory_stock|PGRST205|42P01/i.test(`${r.error.code ?? ''} ${r.error.message ?? ''}`)) {
    return build('inventory_items');
  }
  return r;
}
