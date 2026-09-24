import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { ReviewsManager } from './ReviewsManager';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const { role, perms } = await gatePortalPage(t.client, slug, 'reviews.view');

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Reviews</h1>
        <p className="text-muted text-xs mt-1">
          Ratings and comments guests leave from the order-tracking page after their meal.
        </p>
      </div>
      <ReviewsManager
        canAnalytics={can(perms, role, 'reviews.analytics')}
        canRespond={can(perms, role, 'reviews.respond')}
        canModerate={can(perms, role, 'reviews.moderate')}
      />
    </div>
  );
}
