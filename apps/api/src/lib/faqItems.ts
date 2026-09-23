import { supabaseAdmin } from '../supabase';

/** Reads public.faq_items (control-plane) — published FAQ entries. Same
 *  short in-memory cache as lib/siteContent.ts/lib/plans.ts. */
export type FaqItemRow = {
  id: string;
  category: string;
  question: string;
  answer: string;
  sort_order: number;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: FaqItemRow[] } | null = null;

export async function getPublishedFaqItems(): Promise<FaqItemRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { data, error } = await supabaseAdmin
    .from('faq_items')
    .select('id, category, question, answer, sort_order')
    .eq('is_published', true)
    .eq('status', 'published')
    .order('sort_order');
  if (error) throw error;
  const rows = (data ?? []) as FaqItemRow[];
  cache = { at: Date.now(), rows };
  return rows;
}
