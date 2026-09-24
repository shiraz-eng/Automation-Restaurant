import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { AttendanceInsights } from './AttendanceInsights';
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

  const { role, perms } = await gatePortalPage(t.client, slug, 'attendance.view');

  const offset = Number.parseInt(w ?? '0', 10) || 0;
  const start = weekStart();
  start.setDate(start.getDate() + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const {
    data: { user },
  } = await t.client.auth.getUser();
  const [{ data: members }, { data: shifts, error }, { data: attendance }, { data: me }] = await Promise.all([
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
    user ? t.client.from('memberships').select('id').eq('user_id', user.id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const a = (k: string) => can(perms, role, k);

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
          canManage={can(perms, role, 'attendance.mark')}
        />
      )}
      <AttendanceInsights
        myMembershipId={(me as { id: string } | null)?.id ?? null}
        caps={{
          dashboard: a('attendance.view_dashboard'),
          reports: a('attendance.view_reports'),
          employeeReports: a('attendance.view_employee_reports'),
          history: a('attendance.view_history'),
          exportCsv: a('attendance.export'),
          requestCorrection: a('attendance.request_correction'),
          correct: a('attendance.correct'),
          approveCorrection: a('attendance.approve_correction'),
          viewOwn: a('attendance.view_own') && role !== 'owner',
        }}
      />
    </div>
  );
}
