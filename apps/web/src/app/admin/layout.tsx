import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { AdminSignOut } from './AdminSignOut';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createControlPlaneServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.app_metadata as { role?: string } | undefined)?.role;
  if (!user || role !== 'super_admin') {
    redirect('/admin/login');
  }

  return (
    <div className="min-h-screen flex flex-col bg-main">
      <header className="flex items-center justify-between px-5 h-14 border-b border-border bg-surface shrink-0">
        <Link href="/admin" className="flex items-baseline gap-3">
          <span className="font-black">Automation.</span>
          <span className="text-xs font-bold uppercase tracking-wider text-primary">Platform</span>
        </Link>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="hidden sm:inline">{user.email}</span>
          <AdminSignOut />
        </div>
      </header>
      <main className="flex-1 p-6 md:p-10">{children}</main>
    </div>
  );
}
