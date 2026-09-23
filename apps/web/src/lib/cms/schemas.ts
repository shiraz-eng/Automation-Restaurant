import { z } from 'zod';

/**
 * One Zod schema per site_sections.section_type (supabase/control-plane/
 * 0011_site_content.sql) — validated on both the admin save path (reject
 * bad input before it reaches the DB) and the render path (a missing/
 * malformed row falls back to a bundled default rather than ever crashing
 * the homepage). Only the types actually in use by a converted section are
 * defined here; add the next one exactly when the next section converts —
 * see the CMS plan for the full type roster and conversion order.
 */

const ctaSchema = z.object({ label: z.string().min(1), href: z.string().min(1) });

export const heroContentSchema = z.object({
  badge: z.string(),
  headline: z.string(),
  subhead: z.string(),
  primaryCta: ctaSchema,
  secondaryCta: ctaSchema,
  connects: z.array(z.string()).min(1),
  image: z.object({ src: z.string().min(1), alt: z.string() }),
  kitchenTickets: z.array(z.object({ table: z.string(), status: z.string() })),
  inventoryAlert: z.object({ title: z.string(), text: z.string() }),
  aiRecommendation: z.object({ title: z.string(), text: z.string(), linkText: z.string() }),
});
export type HeroContent = z.infer<typeof heroContentSchema>;

export const flatListContentSchema = z.object({
  heading: z.string(),
  items: z.array(z.string().min(1)).min(1),
});
export type FlatListContent = z.infer<typeof flatListContentSchema>;

// FAQ items now live in their own table (public.faq_items, categorized and
// individually publishable) rather than this section's content — this
// schema only owns the surrounding eyebrow/title copy. See lib/cms/content.ts's
// getFaqItems().
export const faqContentSchema = z.object({
  eyebrow: z.string(),
  title: z.string(),
});
export type FaqContent = z.infer<typeof faqContentSchema>;

export const ctaContentSchema = z.object({
  headline: z.string(),
  subtext: z.string(),
  primaryCta: ctaSchema,
  secondaryCta: ctaSchema,
});
export type CtaContent = z.infer<typeof ctaContentSchema>;

export const copyOnlyContentSchema = z.object({
  eyebrow: z.string(),
  title: z.string(),
  subtitle: z.string(),
});
export type CopyOnlyContent = z.infer<typeof copyOnlyContentSchema>;

export const SECTION_SCHEMAS = {
  hero: heroContentSchema,
  flat_list: flatListContentSchema,
  faq: faqContentSchema,
  cta: ctaContentSchema,
  copy_only: copyOnlyContentSchema,
} as const;
export type SectionType = keyof typeof SECTION_SCHEMAS;

/** Validates raw JSON against its section_type's schema; returns null (never
 *  throws) on a mismatch so a caller can fall back to a bundled default
 *  instead of ever letting a malformed row crash the page it renders on. */
export function parseSectionContent<T extends SectionType>(type: T, raw: unknown): z.infer<(typeof SECTION_SCHEMAS)[T]> | null {
  const schema = SECTION_SCHEMAS[type];
  const result = schema.safeParse(raw);
  return result.success ? (result.data as z.infer<(typeof SECTION_SCHEMAS)[T]>) : null;
}
