import { notFound, redirect } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { isManagement } from '@/lib/portals';
import { SchedulingClient, type Shift, type Attendance } from './SchedulingClient';

export const dynamic = 'force-dynamic';

/** Monday 00:00 of the week containing `d`, in the server's local zone. */
function weekStart(d = new Date()): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

export default async function SchedulingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ w?: string }>;
}) {
  const { slug } = await params;
  const { w } = await searchParams;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const {
    data: { user },
  } = await t.client.auth.getUser();
  if (!user) redirect(`/r/${slug}/login`);
  const role = (user.app_metadata as { role?: string }).role ?? 'owner';
  if (!isManagement(role)) redirect(`/r/${slug}`);

  const offset = Number.parseInt(w ?? '0', 10) || 0;
  const start = weekStart();
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const [{ data: members }, { data: shifts, error }, { data: attendance }] = await Promise.all([
    t.client.from('memberships').select('id, full_name, email, role').order('full_name'),
    t.client
      .from('shifts')
      .select('id, membership_id, starts_at, ends_at, role_label, notes')
      .gte('starts_at', start.toISOString())
      .lt('starts_at', end.toISOString())
      .order('starts_at'),
    t.client
      .from('attendance')
      .select('id, membership_id, clock_in, clock_out, note')
      .order('clock_in', { ascending: false })
      .limit(40),
  ]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-black">Shifts &amp; attendance</h1>
        <p className="text-muted text-xs mt-1">
          Plan the week&rsquo;s rota and keep a clock in / clock out log for payroll.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <SchedulingClient
          slug={slug}
          weekOffset={offset}
          weekStartISO={start.toISOString()}
          members={members ?? []}
          shifts={(shifts ?? []) as Shift[]}
          attendance={(attendance ?? []) as Attendance[]}
        />
      )}
    </div>
  );
}
