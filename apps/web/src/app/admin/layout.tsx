import Link from 'next/link';
import { ChefHat, Store, CreditCard, FileText, Repeat, Receipt, BarChart3, MessageSquare } from 'lucide-react';
import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { AdminSignOut } from './AdminSignOut';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createControlPlaneServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.app_metadata as { role?: string } | undefined)?.role;

  // No redirect here — /admin/login is itself nested under this layout, so
  // redirecting unauthenticated visitors to /admin/login from here would
  // send them right back into this same check, forever. Every individual
  // admin page already re-checks auth itself (redirect('/admin/login')) and
  // is the real gate; this layout just skips its own chrome when logged out
  // so the login page renders cleanly instead of looping.
  if (!user || role !== 'super_admin') return <div className="min-h-screen bg-ink text-ink-fg">{children}</div>;

  const NAV = [
    ['/admin', 'Restaurants', Store],
    ['/admin/plans', 'Plans & Pricing', CreditCard],
    ['/admin/content', 'Site Content', FileText],
    ['/admin/subscriptions', 'Subscriptions', Repeat],
    ['/admin/invoices', 'Invoices', Receipt],
    ['/admin/analytics', 'Analytics', BarChart3],
    ['/admin/messages', 'Messages', MessageSquare],
  ] as const;

  return (
    <div className="min-h-screen flex bg-ink text-ink-fg">
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-white/10 bg-black/30">
        <div className="p-5 pb-4">
          <Link href="/admin" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gold text-ink">
              <ChefHat size={16} strokeWidth={2.5} />
            </span>
            <span className="flex items-baseline gap-1">
              <span className="font-black text-sm">Automation</span>
              <span className="text-gold text-lg leading-none">.</span>
            </span>
          </Link>
          <div className="mt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">Platform Administration</div>
        </div>
        <nav className="flex-1 flex flex-col gap-0.5 px-3">
          {NAV.map(([href, label, Icon]) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-semibold text-ink-muted hover:bg-white/5 hover:text-ink-fg transition-colors"
            >
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-white/10 flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-muted truncate">{user.email}</span>
          <AdminSignOut />
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden flex items-center justify-between px-5 h-14 border-b border-white/10 bg-black/30 shrink-0">
          <Link href="/admin" className="flex items-baseline gap-2">
            <span className="font-black text-sm">Automation</span>
            <span className="text-gold">.</span>
          </Link>
          <AdminSignOut />
        </header>
        <nav className="md:hidden flex items-center gap-3 px-5 py-2 border-b border-white/10 bg-black/30 text-xs font-semibold text-ink-muted overflow-x-auto">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="whitespace-nowrap hover:text-ink-fg">
              {label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 p-6 md:p-10 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
