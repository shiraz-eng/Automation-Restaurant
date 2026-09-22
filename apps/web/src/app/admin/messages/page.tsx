import { createControlPlaneServerClient } from '@/lib/supabase/control-plane-server';
import { gateAdminPage } from '@/lib/adminPermissions';
import { AdminCard } from '../_components/ui';

export const dynamic = 'force-dynamic';

type Row = {
  id: string;
  name: string;
  email: string;
  restaurant: string | null;
  message: string;
  created_at: string;
};

export default async function AdminMessagesPage() {
  const supabase = await createControlPlaneServerClient();
  await gateAdminPage(supabase, 'settings.manage');

  const { data, error } = await supabase
    .from('contact_messages')
    .select('id, name, email, restaurant, message, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = (data ?? []) as Row[];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-black">Contact messages</h1>
        <p className="text-ink-muted text-xs mt-1">Submitted from the public site's contact form.</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 p-4 text-xs">{error.message}</div>
      )}

      {rows.length === 0 ? (
        <AdminCard>
          <p className="text-ink-muted text-xs">No messages yet.</p>
        </AdminCard>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <AdminCard key={r.id}>
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="font-bold text-sm">{r.name}</div>
                  <div className="text-ink-muted text-xs">
                    {r.email}
                    {r.restaurant ? ` · ${r.restaurant}` : ''}
                  </div>
                </div>
                <div className="text-ink-muted text-[11px] whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</div>
              </div>
              <p className="text-xs whitespace-pre-wrap">{r.message}</p>
            </AdminCard>
          ))}
        </div>
      )}
    </div>
  );
}
