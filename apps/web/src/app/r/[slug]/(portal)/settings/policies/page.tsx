import { redirect } from 'next/navigation';

// "Policies" was split into Settings → Currency, Tax and Refund approvals.
// Old bookmarks land on Currency.
export default async function PoliciesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/r/${slug}/settings/currency`);
}
