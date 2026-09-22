import { supabaseAdmin } from '../supabase';

/** Reads public.site_sections (control-plane) — the marketing site's
 *  editable content blocks. Same short in-memory cache as lib/plans.ts. */
export type SiteSectionRow = {
  slug: string;
  section_type: string;
  content: unknown;
  is_active: boolean;
  sort_order: number;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; rows: SiteSectionRow[] } | null = null;

/** ALL rows, active and inactive — a caller needs to see an inactive row to
 *  tell "the admin explicitly hid this section" apart from "no row exists
 *  yet" (the latter renders the section's own bundled default; the former
 *  must not render the section at all). Filtering by is_active happens in
 *  the caller, not here. */
export async function getAllSiteSections(): Promise<SiteSectionRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { data, error } = await supabaseAdmin
    .from('site_sections')
    .select('slug, section_type, content, is_active, sort_order')
    .order('sort_order');
  if (error) throw error;
  const rows = (data ?? []) as SiteSectionRow[];
  cache = { at: Date.now(), rows };
  return rows;
}
