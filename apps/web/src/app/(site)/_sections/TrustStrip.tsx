import { getSectionContent } from '@/lib/cms/content';
import type { FlatListContent } from '@/lib/cms/schemas';

const DEFAULT: FlatListContent = {
  heading: 'Built for restaurants that want one connected system',
  items: ['Quick Service', 'Fast Casual', 'Full Service', 'Cafés & Bakeries', 'Fine Dining', 'Food Trucks', 'Restaurant Groups'],
};

export async function TrustStrip() {
  const result = await getSectionContent('trust-strip', 'flat_list');
  if (result.state === 'hidden') return null;
  const content = result.state === 'active' ? result.content : DEFAULT;
  return (
    <div className="border-y border-border bg-surface">
      <div className="mx-auto max-w-6xl px-5 md:px-8 py-8">
        <p className="text-center text-xs font-semibold uppercase tracking-widest text-muted">{content.heading}</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {content.items.map((t) => (
            <span key={t} className="text-sm font-semibold text-body/70">
              {t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
