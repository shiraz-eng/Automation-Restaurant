import { PayClient } from './PayClient';

export const metadata = { title: 'Payment — Automation Restaurant' };
export const dynamic = 'force-dynamic';

export default async function PayPage({
  searchParams,
}: {
  searchParams: Promise<{ i?: string }>;
}) {
  const { i } = await searchParams;
  return <PayClient intent={i ?? null} />;
}
