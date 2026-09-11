import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** The register folded into the Operations Checkout in P4. */
export default async function RegisterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/r/${slug}/checkout`);
}
