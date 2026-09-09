import { ClaimForm } from './ClaimForm';

export const dynamic = 'force-dynamic';

export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <ClaimForm token={token ?? ''} />;
}
