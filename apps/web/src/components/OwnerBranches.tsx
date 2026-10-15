'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { SupabaseClient } from '@supabase/supabase-js';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';

/**
 * Independent branches in the owner's central panel (API: /api/owner-branches,
 * apps/api lib/branchTenants.ts). Each branch is a restaurant of its own — its own
 * database and workspace; this panel creates them, shows each one's figures side by side,
 * and opens a branch's workspace with a one-time owner sign-in (no second password).
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type BranchMetrics = {
  orders: number;
  net_sales_cents: number;
  cogs_cents: number;
  expenses_cents: number;
  open_low_stock: number;
  payables_outstanding_cents: number;
  unclosed_days: number;
  last_closed_day: string | null;
};
export type OwnerBranch = {
  id: string;
  slug: string;
  code: string;
  name: string;
  status: 'provisioning' | 'active' | 'failed' | 'suspended' | string;
  setup_error: string | null;
  copy_status: 'pending' | 'done' | 'failed' | null;
  copy_error: string | null;
  created_at: string;
  metrics: BranchMetrics | { error: string } | null;
};
type ListResponse = {
  period: { from: string; to: string };
  main: { slug: string; name: string; metrics: BranchMetrics | { error: string } };
  branches: OwnerBranch[];
};

async function call(supabase: SupabaseClient, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API}/api/owner-branches${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.message ?? json.error ?? `Request failed (${res.status})`));
  return json;
}

const isReady = (b: OwnerBranch) => b.status === 'active' && b.copy_status !== 'pending';
const hasFigures = (m: OwnerBranch['metrics']): m is BranchMetrics => !!m && !('error' in m);

/** Open a branch's workspace: a one-time owner sign-in, then the branch's own dashboard. */
async function openBranch(supabase: SupabaseClient, slug: string, b: OwnerBranch) {
  const r = (await call(supabase, 'POST', `/${b.id}/open`, { slug })) as { slug: string; token: string };
  window.location.assign(`/r/${r.slug}/auth/sso#t=${encodeURIComponent(r.token)}`);
}

function useOwnerBranches(slug: string, poll = false) {
  const supabase = usePortalSupabase();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData((await call(supabase, 'GET', `?slug=${encodeURIComponent(slug)}`)) as unknown as ListResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [supabase, slug]);
  useEffect(() => {
    void load();
  }, [load]);
  // While a branch is being set up, move it forward and refresh (the setup runs in steps).
  const busy = useRef(false);
  useEffect(() => {
    if (!poll) return;
    const pending = (data?.branches ?? []).filter((b) => b.status === 'provisioning' || (b.status === 'active' && b.copy_status === 'pending'));
    if (!pending.length) return;
    const t = setTimeout(async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const b of pending) await call(supabase, 'POST', `/${b.id}/advance`, { slug }).catch(() => undefined);
        await load();
      } finally {
        busy.current = false;
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [data, poll, supabase, slug, load]);
  return { data, error, load, supabase };
}

// ── The workspace dropdown (owner panel sidebar) ───────────────────────────────

export function WorkspaceSwitcher({ slug }: { slug: string }) {
  const { data, supabase } = useOwnerBranches(slug);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = (data?.branches ?? []).filter(isReady);
  if (!data) return null;
  return (
    <div className="space-y-1">
      <label className="block text-[10px] font-bold uppercase tracking-wide text-muted" htmlFor="workspace-switch">
        Workspace
      </label>
      <select
        id="workspace-switch"
        className="w-full rounded-full border border-border bg-main px-3 py-1.5 text-xs font-semibold text-body"
        value=""
        disabled={!!opening}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__manage') return void window.location.assign(`/r/${slug}/branches`);
          const b = ready.find((x) => x.id === v);
          if (!b) return;
          setOpening(b.id);
          setError(null);
          openBranch(supabase, slug, b).catch((err) => {
            setOpening(null);
            setError((err as Error).message);
          });
        }}
      >
        <option value="">{opening ? 'Opening…' : 'Owner panel (all branches)'}</option>
        {ready.map((b) => (
          <option key={b.id} value={b.id}>
            {b.code} · {b.name.split(' — ').pop()}
          </option>
        ))}
        <option value="__manage">{ready.length ? 'Manage branches…' : '+ Add a branch…'}</option>
      </select>
      {error && <p className="text-[10px] text-danger">{error}</p>}
    </div>
  );
}

// ── Dashboard: every restaurant side by side ──────────────────────────────────

function Figures({ m }: { m: OwnerBranch['metrics'] }) {
  if (!m) return <p className="text-muted">—</p>;
  if (!hasFigures(m)) return <p className="text-warn">Figures unavailable</p>;
  const op = m.net_sales_cents - m.cogs_cents - m.expenses_cents;
  return (
    <>
      <p className="font-mono text-lg font-black">{formatCents(m.net_sales_cents)}</p>
      <p className="text-muted">
        {m.orders} orders · operating profit <span className={op < 0 ? 'text-danger' : 'text-body'}>{formatCents(op)}</span>
      </p>
      <p className="flex flex-wrap gap-x-3 text-muted">
        <span className={m.open_low_stock ? 'text-danger' : ''}>{m.open_low_stock} low stock</span>
        <span>{formatCents(m.payables_outstanding_cents)} owed</span>
        <span className={m.unclosed_days ? 'text-warn' : ''}>
          {m.unclosed_days ? `${m.unclosed_days} day(s) not closed` : m.last_closed_day ? `closed ${m.last_closed_day}` : 'no day closed yet'}
        </span>
      </p>
    </>
  );
}

export function OwnerBranchesPanel({ slug }: { slug: string }) {
  const { data, supabase } = useOwnerBranches(slug);
  const [error, setError] = useState<string | null>(null);
  if (!data || data.branches.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">Your restaurants · this month</h2>
        <Link href={`/r/${slug}/branches`} className="text-xs text-primary hover:underline">
          Manage branches →
        </Link>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-primary/40 p-3 space-y-1.5 text-xs">
          <p className="font-bold text-sm">
            {data.main.name} <span className="font-normal text-muted">main</span>
          </p>
          <Figures m={data.main.metrics} />
        </div>
        {data.branches.map((b) => (
          <div key={b.id} className="rounded-lg border border-border p-3 space-y-1.5 text-xs">
            <p className="flex items-center justify-between gap-2 font-bold text-sm">
              <span>
                {b.name.split(' — ').pop()} <span className="font-mono font-normal text-muted">{b.code}</span>
              </span>
              {isReady(b) && (
                <button
                  type="button"
                  className="text-[11px] font-semibold text-primary hover:underline"
                  onClick={() => openBranch(supabase, slug, b).catch((e) => setError((e as Error).message))}
                >
                  Open →
                </button>
              )}
            </p>
            {b.status === 'active' ? <Figures m={b.metrics} /> : <p className="text-muted">{b.status === 'failed' ? 'Setup failed' : 'Being set up…'}</p>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted">
        Each restaurant’s figures come from its own database; nothing is merged or counted twice.
      </p>
    </section>
  );
}

// ── Branches page: create, follow setup, open ──────────────────────────────────

const STATUS: Record<string, string> = {
  provisioning: 'Being set up',
  active: 'Ready',
  failed: 'Setup failed',
  suspended: 'Suspended',
};

export function OwnerBranchesManager({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const { data, error, load, supabase } = useOwnerBranches(slug, true);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      const r = (await call(supabase, 'POST', '', { slug, code: code.trim().toUpperCase(), name: name.trim() })) as { existed: boolean };
      setNotice(
        r.existed
          ? `A branch with code ${code.toUpperCase()} already exists — no second one was created.`
          : `Setting up ${name.trim()}: its own database is being created in your Supabase account. This takes a few minutes; you can leave this page.`,
      );
      setCode('');
      setName('');
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry(b: OwnerBranch) {
    setActionError(null);
    try {
      await call(supabase, 'POST', `/${b.id}/retry`, { slug });
      await load();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {(error || actionError) && <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{actionError ?? error}</div>}
      {notice && <div className="rounded border border-ok/40 bg-ok/10 p-3 text-xs text-ok">{notice}</div>}

      {canCreate && (
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h2 className="font-bold text-sm">Add a branch</h2>
          <p className="text-xs text-muted max-w-2xl">
            A branch is a restaurant of its own: its own database in your Supabase account, its own staff, stock, orders, suppliers,
            finance and portals. It starts with a copy of this restaurant’s menu, recipes, ingredients, suppliers, branding, tax and
            currency; after that each one is managed on its own. Note: each branch is a separate Supabase project, which needs a paid
            Supabase plan once you have more than two.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="block text-muted mb-1">Code</span>
              <Input id="branch-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="DHA" className="w-28 font-mono" />
            </label>
            <label className="text-xs">
              <span className="block text-muted mb-1">Name</span>
              <Input id="branch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="DHA Phase 6" className="w-64" />
            </label>
            <Button disabled={busy || code.trim().length < 2 || name.trim().length < 2} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create branch'}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-bold text-sm">Your branches</h2>
        {!data ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : data.branches.length === 0 ? (
          <p className="text-xs text-muted">No branches yet. Each branch you add appears here with its own figures.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2.5 font-semibold">Branch</th>
                  <th className="p-2.5 font-semibold">Status</th>
                  <th className="p-2.5 font-semibold text-right">Orders</th>
                  <th className="p-2.5 font-semibold text-right">Net sales</th>
                  <th className="p-2.5 font-semibold text-right">Operating profit</th>
                  <th className="p-2.5 font-semibold text-right">Low stock</th>
                  <th className="p-2.5 font-semibold text-right">Owed</th>
                  <th className="p-2.5" />
                </tr>
              </thead>
              <tbody>
                {data.branches.map((b) => {
                  const m = hasFigures(b.metrics) ? b.metrics : null;
                  return (
                    <tr key={b.id} className="border-b border-border/60 last:border-0 align-top">
                      <td className="p-2.5">
                        <p className="font-semibold">{b.name.split(' — ').pop()}</p>
                        <p className="font-mono text-muted">
                          {b.code} · /r/{b.slug}
                        </p>
                      </td>
                      <td className="p-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 font-bold ${b.status === 'active' ? 'bg-ok/10 text-ok' : b.status === 'failed' ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'}`}
                        >
                          {STATUS[b.status] ?? b.status}
                        </span>
                        {b.status === 'active' && b.copy_status === 'pending' && <p className="mt-1 text-muted">Copying the menu…</p>}
                        {b.copy_status === 'failed' && <p className="mt-1 text-danger">Menu copy failed: {b.copy_error}</p>}
                        {b.status === 'failed' && b.setup_error && <p className="mt-1 text-danger max-w-xs">{b.setup_error}</p>}
                      </td>
                      <td className="p-2.5 text-right font-mono">{m ? m.orders : '—'}</td>
                      <td className="p-2.5 text-right font-mono">{m ? formatCents(m.net_sales_cents) : '—'}</td>
                      <td className="p-2.5 text-right font-mono">{m ? formatCents(m.net_sales_cents - m.cogs_cents - m.expenses_cents) : '—'}</td>
                      <td className="p-2.5 text-right font-mono">{m ? m.open_low_stock : '—'}</td>
                      <td className="p-2.5 text-right font-mono">{m ? formatCents(m.payables_outstanding_cents) : '—'}</td>
                      <td className="p-2.5 text-right whitespace-nowrap">
                        {isReady(b) && (
                          <Button onClick={() => openBranch(supabase, slug, b).catch((e) => setActionError((e as Error).message))}>Open workspace</Button>
                        )}
                        {(b.status === 'failed' || b.copy_status === 'failed') && canCreate && (
                          <Button variant="ghost" onClick={() => void retry(b)}>
                            Retry
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && <p className="text-[11px] text-muted">Figures: {data.period.from} to {data.period.to}, each from that branch’s own database.</p>}
      </section>
    </div>
  );
}
