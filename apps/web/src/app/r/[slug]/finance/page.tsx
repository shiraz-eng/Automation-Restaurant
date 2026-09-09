import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { StatCard } from '@/components/StatCard';
import { formatCents } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function FinancePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();
  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: paid } = await t.client
    .from('orders')
    .select('total_cents, tax_cents, payment_method, paid_at')
    .not('paid_at', 'is', null)
    .gte('paid_at', since.toISOString());

  const rows = paid ?? [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const sevenAgo = new Date();
  sevenAgo.setDate(sevenAgo.getDate() - 7);

  const sum = (list: typeof rows) => list.reduce((s, r) => s + (r.total_cents ?? 0), 0);
  const inRange = (from: Date) => rows.filter((r) => r.paid_at && new Date(r.paid_at) >= from);

  const today = inRange(startOfToday);
  const week = inRange(sevenAgo);
  const revenue30 = sum(rows);
  const tax30 = rows.reduce((s, r) => s + (r.tax_cents ?? 0), 0);
  const aov = rows.length ? Math.round(revenue30 / rows.length) : 0;

  const byMethod = rows.reduce<Record<string, { count: number; cents: number }>>((acc, r) => {
    const m = r.payment_method ?? 'unknown';
    acc[m] = acc[m] ?? { count: 0, cents: 0 };
    acc[m].count += 1;
    acc[m].cents += r.total_cents ?? 0;
    return acc;
  }, {});

  return (
    <div className="space-y-8 max-w-5xl">
      <h1 className="text-xl font-black">Finance</h1>
      <p className="text-muted text-xs -mt-6">Paid orders, last 30 days.</p>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Revenue today" value={formatCents(sum(today))} hint={`${today.length} orders`} />
        <StatCard label="Revenue 7d" value={formatCents(sum(week))} hint={`${week.length} orders`} />
        <StatCard label="Revenue 30d" value={formatCents(revenue30)} hint={`${rows.length} orders`} />
        <StatCard label="Avg order value" value={formatCents(aov)} />
      </section>

      <section className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold text-sm mb-3">Payment methods (30d)</h2>
          {Object.keys(byMethod).length === 0 ? (
            <p className="text-muted text-xs">No paid orders yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <tbody>
                {Object.entries(byMethod).map(([m, v]) => (
                  <tr key={m} className="border-b border-border/60 last:border-0">
                    <td className="py-2 capitalize font-semibold">{m}</td>
                    <td className="py-2 text-muted">{v.count} orders</td>
                    <td className="py-2 text-right font-bold">{formatCents(v.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface p-5">
          <h2 className="font-bold text-sm mb-3">Summary (30d)</h2>
          <dl className="text-xs space-y-2">
            <div className="flex justify-between">
              <dt className="text-muted">Gross revenue</dt>
              <dd className="font-bold">{formatCents(revenue30)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Tax collected</dt>
              <dd className="font-bold">{formatCents(tax30)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Net of tax</dt>
              <dd className="font-bold">{formatCents(revenue30 - tax30)}</dd>
            </div>
          </dl>
          <p className="text-muted text-[11px] mt-3">
            Expenses, COGS and payroll need their own modules — not built yet.
          </p>
        </div>
      </section>
    </div>
  );
}
