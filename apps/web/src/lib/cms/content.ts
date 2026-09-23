import { parseSectionContent, type SectionType } from './schemas';

/**
 * Server-side fetch of the marketing site's editable sections from
 * public.site_sections (supabase/control-plane/0011_site_content.sql), via
 * GET /api/public/site-content — same pattern as apps/web/src/lib/plans.ts.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type SiteSectionRow = { slug: string; section_type: string; content: unknown; is_active: boolean; sort_order: number };

// No caching at this layer — the API (apps/api/src/lib/siteContent.ts) already
// caches for 60s; stacking a second cache here would double that lag between
// an admin save and it showing live, same reasoning apps/web/src/lib/plans.ts
// already settled for the identical plans-fetch shape.
async function fetchAllSections(): Promise<SiteSectionRow[]> {
  try {
    const res = await fetch(`${API}/api/public/site-content`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { sections: SiteSectionRow[] };
    return body.sections ?? [];
  } catch {
    return [];
  }
}

/**
 * A section's content by slug, in one of three states a caller must
 * distinguish (conflating them was a real bug caught in live testing —
 * "hidden" was rendering the default instead of disappearing):
 * - `active`: a real, valid, is_active row — render `content`.
 * - `hidden`: the row exists and is explicitly is_active=false — the admin
 *   turned this section off; render nothing.
 * - `missing`: no row (not yet converted to the CMS, or a transient fetch/
 *   validation failure) — render the section's own bundled default rather
 *   than ever crashing the homepage over it.
 */
export type SectionResult<T> = { state: 'active'; content: T } | { state: 'hidden' } | { state: 'missing' };

export type FaqItem = { id: string; category: string; question: string; answer: string };

/** Published FAQ items, grouped by category in sort_order — backs
 *  FaqSection.tsx. Same no-web-layer-cache convention as fetchAllSections. */
export async function getFaqItems(): Promise<{ category: string; items: { q: string; a: string }[] }[]> {
  try {
    const res = await fetch(`${API}/api/public/faq-items`, { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { items: FaqItem[] };
    const items = body.items ?? [];
    const byCategory = new Map<string, { q: string; a: string }[]>();
    for (const item of items) {
      const list = byCategory.get(item.category) ?? [];
      list.push({ q: item.question, a: item.answer });
      byCategory.set(item.category, list);
    }
    return [...byCategory.entries()].map(([category, items]) => ({ category, items }));
  } catch {
    return [];
  }
}

export async function getSectionContent<T extends SectionType>(
  slug: string,
  type: T,
): Promise<SectionResult<Exclude<ReturnType<typeof parseSectionContent<T>>, null>>> {
  const rows = await fetchAllSections();
  const row = rows.find((r) => r.slug === slug && r.section_type === type);
  if (!row) return { state: 'missing' };
  if (!row.is_active) return { state: 'hidden' };
  const parsed = parseSectionContent(type, row.content);
  if (!parsed) return { state: 'missing' };
  return { state: 'active', content: parsed as Exclude<ReturnType<typeof parseSectionContent<T>>, null> };
}
