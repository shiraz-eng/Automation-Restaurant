import { OnboardingStatus } from './OnboardingStatus';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <OnboardingStatus slug={slug} />;
}
