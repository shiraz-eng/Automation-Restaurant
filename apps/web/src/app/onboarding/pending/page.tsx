import { PendingClient } from './PendingClient';

export const metadata = { title: 'Confirming your order — Automation Restaurant' };
export const dynamic = 'force-dynamic';

export default async function PendingPage({
  searchParams,
}: {
  searchParams: Promise<{ cs?: string }>;
}) {
  const { cs } = await searchParams;
  return <PendingClient checkoutSessionId={cs ?? null} />;
}
