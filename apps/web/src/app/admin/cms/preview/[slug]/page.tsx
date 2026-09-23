import { Hero } from '@/app/(site)/_sections/Hero';
import { TrustStrip } from '@/app/(site)/_sections/TrustStrip';
import { FaqSection } from '@/app/(site)/_sections/FaqSection';
import { FinalCta } from '@/app/(site)/_sections/FinalCta';
import { PricingTeaser } from '@/app/(site)/_sections/PricingTeaser';
import { parseSectionContent, type SectionType } from '@/lib/cms/schemas';

export const dynamic = 'force-dynamic';

/**
 * Renders the ACTUAL production section component with draft content
 * substituted in, via a real Next.js route (so React Server Component
 * rendering works normally) — mounted in an iframe by the CMS editor. This
 * is what lets the preview reuse the real renderer instead of building a
 * second one: a client component can't call an async Server Component
 * directly, so the editor re-navigates this route's iframe on each edit
 * instead.
 */
const SECTIONS: Record<string, { type: SectionType; render: (content: unknown) => React.ReactNode }> = {
  hero: { type: 'hero', render: (c) => <Hero previewContent={c as never} /> },
  'trust-strip': { type: 'flat_list', render: (c) => <TrustStrip previewContent={c as never} /> },
  faq: { type: 'faq', render: (c) => <FaqSection previewContent={c as never} /> },
  'final-cta': { type: 'cta', render: (c) => <FinalCta previewContent={c as never} /> },
  'pricing-teaser': { type: 'copy_only', render: (c) => <PricingTeaser previewContent={c as never} /> },
};

export default async function CmsPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const { slug } = await params;
  const { draft } = await searchParams;
  const entry = SECTIONS[slug];
  if (!entry) {
    return <div className="p-8 text-sm text-ink-fg bg-ink">No preview available for &ldquo;{slug}&rdquo;.</div>;
  }

  let content: unknown = undefined;
  if (draft) {
    try {
      const raw = JSON.parse(Buffer.from(draft, 'base64').toString('utf8'));
      content = parseSectionContent(entry.type, raw) ?? undefined;
    } catch {
      content = undefined;
    }
  }

  return <div className="bg-ink min-h-screen">{entry.render(content)}</div>;
}
