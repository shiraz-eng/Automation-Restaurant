import { Section } from '@/components/marketing/Section';
import { FaqAccordion } from '@/components/FaqAccordion';
import { getSectionContent, getFaqItems } from '@/lib/cms/content';
import type { FaqContent } from '@/lib/cms/schemas';

const DEFAULT: FaqContent = { eyebrow: 'FAQ', title: 'Questions? We’ve got you covered.' };

export async function FaqSection({ previewContent }: { previewContent?: FaqContent } = {}) {
  if (previewContent) {
    const groups = await getFaqItems();
    return <FaqSectionView content={previewContent} groups={groups} />;
  }
  const [result, groups] = await Promise.all([getSectionContent('faq', 'faq'), getFaqItems()]);
  if (result.state === 'hidden') return null;
  const content = result.state === 'active' ? result.content : DEFAULT;
  return <FaqSectionView content={content} groups={groups} />;
}

function FaqSectionView({
  content,
  groups,
}: {
  content: FaqContent;
  groups: { category: string; items: { q: string; a: string }[] }[];
}) {
  return (
    <Section id="faq" width="narrow" eyebrow={content.eyebrow} title={content.title}>
      {groups.length === 0 ? (
        <p className="text-center text-sm text-muted">No FAQs published yet.</p>
      ) : groups.length === 1 ? (
        <FaqAccordion items={groups[0].items} />
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <div key={g.category}>
              <h3 className="text-sm font-bold uppercase tracking-wide text-muted mb-3">{g.category}</h3>
              <FaqAccordion items={g.items} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
