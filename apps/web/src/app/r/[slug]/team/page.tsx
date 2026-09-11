import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The team page folded into Operations → Staff / Shifts in P6. */
export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/r/${slug}/staff`);
}
