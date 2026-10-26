'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
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
  status: 'provisioning' | 'active' | 'failed' | 'archived' | string;
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

async function call(supabase: SupabaseClient, method: 'GET' | 'POST' | 'PATCH', path: string, body?: Record<string, unknown>) {
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

function useOwnerBranches(slug: string, poll = false, period?: { from: string; to: string }) {
  const supabase = usePortalSupabase();
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const range = period ? `&from=${period.from}&to=${period.to}` : '';
      setData((await call(supabase, 'GET', `?slug=${encodeURIComponent(slug)}${range}`)) as unknown as ListResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [supabase, slug, period?.from, period?.to]);
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
      <label className="block text-[0.625rem] font-bold uppercase tracking-wide text-muted" htmlFor="workspace-switch">
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
      {error && <p className="text-[0.625rem] text-danger">{error}</p>}
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
  const branches = (data?.branches ?? []).filter((b) => b.status !== 'archived');
  if (!data || branches.length === 0) return null;
  // The owner panel only shows its own sales when it has any (a restaurant that traded before it had branches).
  const showMain = hasFigures(data.main.metrics) && data.main.metrics.orders > 0;
  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">Your branches · this month</h2>
        <span className="flex gap-3 text-xs">
          <Link href={`/r/${slug}/branches/compare`} className="text-primary hover:underline">
            Compare →
          </Link>
          <Link href={`/r/${slug}/branches`} className="text-primary hover:underline">
            Manage branches →
          </Link>
        </span>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {showMain && (
          <div className="rounded-lg border border-primary/40 p-3 space-y-1.5 text-xs">
            <p className="font-bold text-sm">
              {data.main.name} <span className="font-normal text-muted">owner panel</span>
            </p>
            <Figures m={data.main.metrics} />
          </div>
        )}
        {branches.map((b) => (
          <div key={b.id} className="rounded-lg border border-border p-3 space-y-1.5 text-xs">
            <p className="flex items-center justify-between gap-2 font-bold text-sm">
              <span>
                {b.name.split(' — ').pop()} <span className="font-mono font-normal text-muted">{b.code}</span>
              </span>
              {isReady(b) && (
                <button
                  type="button"
                  className="text-[0.6875rem] font-semibold text-primary hover:underline"
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
      <p className="text-[0.6875rem] text-muted">
        Each restaurant’s figures come from its own database; nothing is merged or counted twice.
      </p>
    </section>
  );
}

// ── Branches page: create, follow setup, open, manage ─────────────────────────

const STATUS: Record<string, string> = {
  provisioning: 'Being set up',
  active: 'Ready',
  failed: 'Setup failed',
  archived: 'Archived',
};
const statusClass = (s: string) =>
  s === 'active' ? 'bg-ok/10 text-ok' : s === 'failed' ? 'bg-danger/10 text-danger' : s === 'archived' ? 'bg-main text-muted' : 'bg-warn/10 text-warn';
const shortName = (b: OwnerBranch) => b.name.split(' — ').pop() ?? b.name;

type LoginInfo = { login: { email: string; name: string | null } | null; url: string };

/** A password shown once, with a copy button. It isn't stored readable anywhere. */
function ShownOnce({ email, password, url }: { email: string; password: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const full = `${typeof window !== 'undefined' ? window.location.origin : ''}${url}`;
  const text = `Login: ${full}\nEmail: ${email}\nPassword: ${password}`;
  return (
    <div className="rounded border border-ok/40 bg-ok/10 p-3 space-y-1 text-xs">
      <p className="font-bold text-ok">Copy this now — the password is shown only once.</p>
      <pre className="whitespace-pre-wrap font-mono text-body">{text}</pre>
      <Button
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy login details'}
      </Button>
    </div>
  );
}

function BranchLoginPanel({ slug, b, supabase }: { slug: string; b: OwnerBranch; supabase: SupabaseClient }) {
  const [info, setInfo] = useState<LoginInfo | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = (await call(supabase, 'GET', `/${b.id}/login?slug=${encodeURIComponent(slug)}`)) as unknown as LoginInfo;
      setInfo(r);
      setEmail(r.login?.email ?? '');
      setName(r.login?.name ?? '');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [supabase, b.id, slug]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setShown(null);
    try {
      const r = (await call(supabase, 'POST', `/${b.id}/login`, { slug, ...body })) as { email: string; password: string | null };
      if (r.password) setShown({ email: r.email, password: r.password });
      setPassword('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info && !error) return <p className="text-xs text-muted">Loading the login…</p>;
  const has = Boolean(info?.login);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold">Branch login</h3>
      <p className="text-[0.6875rem] text-muted max-w-xl">
        The branch manager signs in at the address below. They run this branch — orders, kitchen, menu, stock, suppliers, finance, staff
        and portals — but never see billing, restaurant settings or other branches.
      </p>
      {info && (
        <p className="text-xs">
          <span className="text-muted">Sign-in address: </span>
          <a className="font-mono text-primary hover:underline" href={info.url} target="_blank" rel="noreferrer">
            {info.url}
          </a>
          {has && (
            <>
              <span className="text-muted"> · Email: </span>
              <span className="font-mono font-semibold">{info.login!.email}</span>
            </>
          )}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {shown && info && <ShownOnce email={shown.email} password={shown.password} url={info.url} />}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="block text-muted mb-1">Email</span>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dha.manager@example.com" className="w-60" />
        </label>
        <label className="text-xs">
          <span className="block text-muted mb-1">Manager name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" className="w-44" />
        </label>
        <label className="text-xs">
          <span className="block text-muted mb-1">{has ? 'New password (optional)' : 'Password (blank = generate one)'}</span>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className="w-48" autoComplete="new-password" />
        </label>
        <Button
          disabled={busy || !email.trim() || (password.length > 0 && password.length < 8)}
          onClick={() => void save({ email: email.trim(), name: name.trim() || null, ...(password ? { password } : {}) })}
        >
          {busy ? 'Saving…' : has ? 'Save login' : 'Create login'}
        </Button>
        {has && (
          <Button variant="ghost" disabled={busy} onClick={() => void save({ new_password: true })}>
            Generate new password
          </Button>
        )}
      </div>
    </div>
  );
}

type Receipt = {
  address: string | null;
  phone: string | null;
  contact_email: string | null;
  website: string | null;
  tax_registration_number: string | null;
  receipt_footer_text: string | null;
};
const RECEIPT_INPUTS: [keyof Receipt, string, string][] = [
  ['address', 'Address', 'Plot 12, DHA Phase 6, Karachi'],
  ['phone', 'Phone', '021-XXXXXXX'],
  ['contact_email', 'Email', 'dha@yourrestaurant.com'],
  ['website', 'Website', 'yourrestaurant.com'],
  ['tax_registration_number', 'Tax / NTN number', 'Optional'],
  ['receipt_footer_text', 'Receipt footer', 'Thank you for dining with us!'],
];

/** The branch's own address, phone and other details printed on ITS receipts and invoices. */
function BranchReceiptPanel({ slug, b, supabase }: { slug: string; b: OwnerBranch; supabase: SupabaseClient }) {
  const [form, setForm] = useState<Receipt | null>(null);
  const [saved, setSaved] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    call(supabase, 'GET', `/${b.id}/receipt?slug=${encodeURIComponent(slug)}`)
      .then((r) => {
        const rec = (r as { receipt: Receipt }).receipt;
        setForm(rec);
        setSaved(rec);
      })
      .catch((e) => setError((e as Error).message));
  }, [supabase, b.id, slug]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const r = (await call(supabase, 'POST', `/${b.id}/receipt`, { slug, ...form })) as { receipt: Receipt };
      setForm(r.receipt);
      setSaved(r.receipt);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const changed = !!form && !!saved && RECEIPT_INPUTS.some(([k]) => (form[k] ?? '') !== (saved[k] ?? ''));
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold">Receipt details</h3>
      <p className="text-[0.6875rem] text-muted max-w-xl">
        Printed on this branch’s receipts and invoices only — every branch has its own address and phone. The receipt layout came from
        the main restaurant; change it in the branch’s Brand Kit.
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!form ? (
        !error && <p className="text-xs text-muted">Loading…</p>
      ) : (
        <>
          {!saved?.address && !saved?.phone && (
            <p className="text-xs text-warn">This branch has no address or phone yet, so its receipts show none.</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {RECEIPT_INPUTS.map(([k, label, ph]) => (
              <label key={k} className={`text-xs ${k === 'address' || k === 'receipt_footer_text' ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
                <span className="block text-muted mb-1">{label}</span>
                <Input
                  value={form[k] ?? ''}
                  placeholder={ph}
                  onChange={(e) => {
                    setDone(false);
                    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
                  }}
                  className="w-full"
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save receipt details'}
            </Button>
            {done && <span className="text-xs text-ok">Saved — the next receipt at {b.code} uses them.</span>}
          </div>
        </>
      )}
    </div>
  );
}

function BranchManagePanel({
  slug,
  b,
  supabase,
  onChanged,
  onDeleted,
}: {
  slug: string;
  b: OwnerBranch;
  supabase: SupabaseClient;
  onChanged: () => Promise<void>;
  onDeleted: (msg: string) => void;
}) {
  const [name, setName] = useState(shortName(b));
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(what: string, fn: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-main/40 p-4">
      {error && <p className="text-xs text-danger">{error}</p>}
      {b.status === 'active' && <BranchLoginPanel slug={slug} b={b} supabase={supabase} />}
      {b.status === 'active' && <BranchReceiptPanel slug={slug} b={b} supabase={supabase} />}

      <div className="space-y-2">
        <h3 className="text-xs font-bold">Edit</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-muted mb-1">Branch name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
          </label>
          <Button
            variant="ghost"
            disabled={!!busy || name.trim().length < 2 || name.trim() === shortName(b)}
            onClick={() => void run('rename', () => call(supabase, 'PATCH', `/${b.id}`, { slug, name: name.trim() }))}
          >
            {busy === 'rename' ? 'Saving…' : 'Save name'}
          </Button>
          <span className="text-[0.6875rem] text-muted">The code ({b.code}) and the address stay the same.</span>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-bold">Archive</h3>
        {b.status === 'archived' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Archived: nobody can sign in or order. Every record is kept.</span>
            <Button variant="ghost" disabled={!!busy} onClick={() => void run('restore', () => call(supabase, 'POST', `/${b.id}/restore`, { slug }))}>
              {busy === 'restore' ? 'Restoring…' : 'Restore branch'}
            </Button>
          </div>
        ) : b.status === 'active' ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Switch the branch off — no sign-ins, no orders — but keep all its data. You can restore it later.</span>
            <Button variant="ghost" disabled={!!busy} onClick={() => void run('archive', () => call(supabase, 'POST', `/${b.id}/archive`, { slug }))}>
              {busy === 'archive' ? 'Archiving…' : 'Archive branch'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Only a ready branch can be archived.</p>
        )}
      </div>

      <div className="space-y-2 rounded border border-danger/40 p-3">
        <h3 className="text-xs font-bold text-danger">Delete permanently</h3>
        <p className="text-[0.6875rem] text-muted max-w-xl">
          Deletes this branch’s Supabase project and everything in it — orders, stock, staff, finance — for good. This cannot be undone.
          Type <span className="font-mono font-bold text-body">{b.code}</span> to confirm.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value.toUpperCase())} placeholder={b.code} className="w-28 font-mono" />
          <Button
            variant="danger"
            disabled={!!busy || confirm !== b.code || b.status === 'provisioning'}
            onClick={() => {
              setBusy('delete');
              setError(null);
              call(supabase, 'POST', `/${b.id}/delete`, { slug, confirm })
                .then(() => onDeleted(`${shortName(b)} (${b.code}) was deleted with all its data.`))
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(null));
            }}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete branch permanently'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function OwnerBranchesManager({ slug, canCreate }: { slug: string; canCreate: boolean }) {
  const { data, error, load, supabase } = useOwnerBranches(slug, true);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  // The new branch's own receipt details, written into it as soon as its database is ready.
  const emptyReceipt: Receipt = { address: null, phone: null, contact_email: null, website: null, tax_registration_number: null, receipt_footer_text: null };
  const [receipt, setReceipt] = useState<Receipt>(emptyReceipt);

  async function create() {
    setBusy(true);
    setNotice(null);
    setActionError(null);
    try {
      const r = (await call(supabase, 'POST', '', { slug, code: code.trim().toUpperCase(), name: name.trim(), receipt })) as {
        existed: boolean;
        receipt_pending: boolean;
      };
      const hasReceipt = RECEIPT_INPUTS.some(([k]) => (receipt[k] ?? '').trim());
      setNotice(
        r.existed
          ? `A branch with code ${code.toUpperCase()} already exists — no second one was created.`
          : `Setting up ${name.trim()}: its own database is being created in your Supabase account. This takes a few minutes; you can leave this page.${
              hasReceipt
                ? r.receipt_pending
                  ? ' Its receipt details are saved and go in as soon as it is ready.'
                  : ' Its receipt details could not be saved yet — set them in Manage → Receipt details once it is ready.'
                : ''
            } When it is ready, open Manage to give it a login.`,
      );
      setCode('');
      setName('');
      setReceipt(emptyReceipt);
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

  const live = (data?.branches ?? []).filter((b) => b.status !== 'archived');
  const archived = (data?.branches ?? []).filter((b) => b.status === 'archived');

  const row = (b: OwnerBranch) => {
    const m = hasFigures(b.metrics) ? b.metrics : null;
    const open = managing === b.id;
    return (
      <Fragment key={b.id}>
        <tr className="border-b border-border/60 align-top">
          <td className="p-2.5">
            <p className="font-semibold">{shortName(b)}</p>
            <p className="font-mono text-muted">
              {b.code} · /r/{b.slug}
            </p>
          </td>
          <td className="p-2.5">
            <span className={`rounded px-1.5 py-0.5 font-bold ${statusClass(b.status)}`}>{STATUS[b.status] ?? b.status}</span>
            {b.status === 'active' && b.copy_status === 'pending' && <p className="mt-1 text-muted">Copying the menu…</p>}
            {b.copy_status === 'failed' && <p className="mt-1 text-danger">Menu copy failed: {b.copy_error}</p>}
            {b.status === 'failed' && b.setup_error && <p className="mt-1 text-danger max-w-xs">{b.setup_error}</p>}
          </td>
          <td className="p-2.5 text-right font-mono">{m ? m.orders : '—'}</td>
          <td className="p-2.5 text-right font-mono">{m ? formatCents(m.net_sales_cents) : '—'}</td>
          <td className="p-2.5 text-right font-mono">{m ? formatCents(m.net_sales_cents - m.cogs_cents - m.expenses_cents) : '—'}</td>
          <td className="p-2.5 text-right font-mono">{m ? m.open_low_stock : '—'}</td>
          <td className="p-2.5 text-right font-mono">{m ? formatCents(m.payables_outstanding_cents) : '—'}</td>
          <td className="p-2.5 text-right whitespace-nowrap space-x-1">
            {isReady(b) && (
              <Button onClick={() => openBranch(supabase, slug, b).catch((e) => setActionError((e as Error).message))}>Open workspace</Button>
            )}
            {(b.status === 'failed' || b.copy_status === 'failed') && canCreate && (
              <Button variant="ghost" onClick={() => void retry(b)}>
                Retry
              </Button>
            )}
            {canCreate && b.status !== 'provisioning' && (
              <Button variant="ghost" aria-expanded={open} onClick={() => setManaging(open ? null : b.id)}>
                {open ? 'Close' : 'Manage'}
              </Button>
            )}
          </td>
        </tr>
        {open && (
          <tr className="border-b border-border/60">
            <td colSpan={8} className="p-2.5">
              <BranchManagePanel
                slug={slug}
                b={b}
                supabase={supabase}
                onChanged={load}
                onDeleted={(msg) => {
                  setManaging(null);
                  setNotice(msg);
                  void load();
                }}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const table = (rows: OwnerBranch[]) => (
    <div className="overflow-x-auto rounded-lg border border-border" tabIndex={0} role="group" aria-label="Table — scroll to see more">
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
        <tbody>{rows.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      {(error || actionError) && <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{actionError ?? error}</div>}
      {notice && <div className="rounded border border-ok/40 bg-ok/10 p-3 text-xs text-ok">{notice}</div>}

      {canCreate && (
        <section className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <h2 className="font-bold text-sm">Add a branch</h2>
          <p className="text-xs text-muted max-w-2xl">
            A branch is a restaurant of its own: its own database in your Supabase account, its own login, staff, stock, orders, suppliers,
            finance and portals. It starts with a copy of the menu, recipes, ingredients, suppliers, branding, tax and currency — from
            this panel if it has a menu, otherwise from your first branch; after that each branch is managed on its own. Each branch is a
            separate Supabase project: the free Supabase plan allows two.
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
          </div>
          <fieldset className="rounded border border-border p-3 space-y-2">
            <legend className="px-1 text-xs font-bold">Receipt details for this branch</legend>
            <p className="text-[0.6875rem] text-muted max-w-2xl">
              Printed on this branch’s receipts and invoices. Only you can change them later (Manage → Receipt details); the branch
              manager prints with them but can’t edit them.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {RECEIPT_INPUTS.map(([k, label, ph]) => (
                <label key={k} className={`text-xs ${k === 'address' || k === 'receipt_footer_text' ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
                  <span className="block text-muted mb-1">{label}</span>
                  <Input value={receipt[k] ?? ''} placeholder={ph} onChange={(e) => setReceipt((r) => ({ ...r, [k]: e.target.value }))} className="w-full" />
                </label>
              ))}
            </div>
          </fieldset>
          <Button disabled={busy || code.trim().length < 2 || name.trim().length < 2} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create branch'}
          </Button>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-bold text-sm">Your branches</h2>
          <Link href={`/r/${slug}/branches/compare`} className="text-xs text-primary hover:underline">
            Compare branches →
          </Link>
        </div>
        {!data ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : live.length === 0 ? (
          <p className="text-xs text-muted">No branches yet. Each branch you add appears here with its own figures.</p>
        ) : (
          table(live)
        )}
        {data && <p className="text-[0.6875rem] text-muted">Figures: {data.period.from} to {data.period.to}, each from that branch’s own database.</p>}
      </section>

      {archived.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold text-sm">Archived</h2>
          {table(archived)}
        </section>
      )}
    </div>
  );
}

// ── Branch comparison ─────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);
function presetRange(p: string): { from: string; to: string } {
  const now = new Date();
  const today = iso(now);
  if (p === 'last-month') {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: iso(new Date(first.getTime() - first.getTimezoneOffset() * 60000)), to: iso(new Date(last.getTime() - last.getTimezoneOffset() * 60000)) };
  }
  if (p === '7d' || p === '30d') {
    const d = new Date(now);
    d.setDate(d.getDate() - (p === '7d' ? 6 : 29));
    return { from: iso(d), to: today };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

type CompareRow = { key: string; label: string; code: string | null; m: BranchMetrics };

export function BranchComparison({ slug }: { slug: string }) {
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(() => presetRange('month'));
  const { data, error } = useOwnerBranches(slug, false, range);

  const rows: CompareRow[] = [];
  if (data) {
    if (hasFigures(data.main.metrics) && data.main.metrics.orders > 0) {
      rows.push({ key: 'main', label: `${data.main.name} (owner panel)`, code: null, m: data.main.metrics });
    }
    for (const b of data.branches) {
      if (b.status === 'active' && hasFigures(b.metrics)) rows.push({ key: b.id, label: shortName(b), code: b.code, m: b.metrics });
    }
  }
  const unavailable = (data?.branches ?? []).filter((b) => b.status === 'active' && !hasFigures(b.metrics));
  const sum = (k: keyof BranchMetrics) => rows.reduce((s, r) => s + Number(r.m[k] ?? 0), 0);
  const total = {
    orders: sum('orders'),
    net: sum('net_sales_cents'),
    cogs: sum('cogs_cents'),
    exp: sum('expenses_cents'),
    low: sum('open_low_stock'),
    owed: sum('payables_outstanding_cents'),
    unclosed: sum('unclosed_days'),
  };
  const maxNet = Math.max(1, ...rows.map((r) => r.m.net_sales_cents));
  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const best = rows.length > 1 ? rows.reduce((a, r) => (r.m.net_sales_cents - r.m.cogs_cents - r.m.expenses_cents > a.m.net_sales_cents - a.m.cogs_cents - a.m.expenses_cents ? r : a)) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        {[
          ['month', 'This month'],
          ['last-month', 'Last month'],
          ['7d', 'Last 7 days'],
          ['30d', 'Last 30 days'],
        ].map(([k, l]) => (
          <Button
            key={k}
            variant={preset === k ? 'primary' : 'ghost'}
            aria-pressed={preset === k}
            onClick={() => {
              setPreset(k);
              setRange(presetRange(k));
            }}
          >
            {l}
          </Button>
        ))}
        <label className="ml-2">
          <span className="block text-muted mb-1">From</span>
          <Input type="date" value={range.from} onChange={(e) => (setPreset('custom'), setRange((r) => ({ ...r, from: e.target.value })))} />
        </label>
        <label>
          <span className="block text-muted mb-1">To</span>
          <Input type="date" value={range.to} onChange={(e) => (setPreset('custom'), setRange((r) => ({ ...r, to: e.target.value })))} />
        </label>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
      {!data ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">No ready branches with figures for this period yet.</p>
      ) : (
        <>
          {best && (
            <p className="text-xs">
              <span className="text-muted">Most profitable in this period: </span>
              <span className="font-bold">{best.label}</span>
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-border" tabIndex={0} role="group" aria-label="Table — scroll to see more">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2.5 font-semibold">Branch</th>
                  <th className="p-2.5 font-semibold text-right">Orders</th>
                  <th className="p-2.5 font-semibold">Net sales</th>
                  <th className="p-2.5 font-semibold text-right">Food cost</th>
                  <th className="p-2.5 font-semibold text-right">Food cost %</th>
                  <th className="p-2.5 font-semibold text-right">Expenses</th>
                  <th className="p-2.5 font-semibold text-right">Operating profit</th>
                  <th className="p-2.5 font-semibold text-right">Margin</th>
                  <th className="p-2.5 font-semibold text-right">Avg order</th>
                  <th className="p-2.5 font-semibold text-right">Low stock</th>
                  <th className="p-2.5 font-semibold text-right">Owed</th>
                  <th className="p-2.5 font-semibold text-right">Days not closed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const op = r.m.net_sales_cents - r.m.cogs_cents - r.m.expenses_cents;
                  return (
                    <tr key={r.key} className="border-b border-border/60">
                      <td className="p-2.5">
                        <span className="font-semibold">{r.label}</span> {r.code && <span className="font-mono text-muted">{r.code}</span>}
                      </td>
                      <td className="p-2.5 text-right font-mono">{r.m.orders}</td>
                      <td className="p-2.5 min-w-[11rem]">
                        <div className="flex items-center gap-2">
                          <div className="h-2 flex-1 rounded bg-main">
                            <div className="h-2 rounded bg-primary" style={{ width: `${(r.m.net_sales_cents / maxNet) * 100}%` }} />
                          </div>
                          <span className="font-mono">{formatCents(r.m.net_sales_cents)}</span>
                        </div>
                      </td>
                      <td className="p-2.5 text-right font-mono">{formatCents(r.m.cogs_cents)}</td>
                      <td className="p-2.5 text-right font-mono">{pct(r.m.cogs_cents, r.m.net_sales_cents)}</td>
                      <td className="p-2.5 text-right font-mono">{formatCents(r.m.expenses_cents)}</td>
                      <td className={`p-2.5 text-right font-mono font-semibold ${op < 0 ? 'text-danger' : ''}`}>{formatCents(op)}</td>
                      <td className="p-2.5 text-right font-mono">{pct(op, r.m.net_sales_cents)}</td>
                      <td className="p-2.5 text-right font-mono">{r.m.orders ? formatCents(Math.round(r.m.net_sales_cents / r.m.orders)) : '—'}</td>
                      <td className={`p-2.5 text-right font-mono ${r.m.open_low_stock ? 'text-danger' : ''}`}>{r.m.open_low_stock}</td>
                      <td className="p-2.5 text-right font-mono">{formatCents(r.m.payables_outstanding_cents)}</td>
                      <td className={`p-2.5 text-right font-mono ${r.m.unclosed_days ? 'text-warn' : ''}`}>{r.m.unclosed_days}</td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 1 && (
                <tfoot className="border-t border-border font-bold">
                  <tr>
                    <td className="p-2.5">All branches</td>
                    <td className="p-2.5 text-right font-mono">{total.orders}</td>
                    <td className="p-2.5 font-mono">{formatCents(total.net)}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.cogs)}</td>
                    <td className="p-2.5 text-right font-mono">{pct(total.cogs, total.net)}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.exp)}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.net - total.cogs - total.exp)}</td>
                    <td className="p-2.5 text-right font-mono">{pct(total.net - total.cogs - total.exp, total.net)}</td>
                    <td className="p-2.5 text-right font-mono">{total.orders ? formatCents(Math.round(total.net / total.orders)) : '—'}</td>
                    <td className="p-2.5 text-right font-mono">{total.low}</td>
                    <td className="p-2.5 text-right font-mono">{formatCents(total.owed)}</td>
                    <td className="p-2.5 text-right font-mono">{total.unclosed}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="text-[0.6875rem] text-muted">
            {data.period.from} to {data.period.to}. Each row comes from that branch’s own database; the total is their sum, nothing is
            counted twice. Operating profit = net sales − food cost − approved expenses.
            {unavailable.length > 0 && ` Not reachable right now: ${unavailable.map((b) => b.code).join(', ')}.`}
          </p>
        </>
      )}
    </div>
  );
}

// ── The owner panel's home ────────────────────────────────────────────────────

/** The main panel's dashboard for a multi-branch restaurant: every branch at a glance. */
export function OwnerPanelHome({ slug, name }: { slug: string; name: string }) {
  const { data, error } = useOwnerBranches(slug, true);
  const branches = (data?.branches ?? []).filter((b) => b.status !== 'archived');
  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-black">Owner panel</h1>
        <p className="text-muted text-xs mt-1 max-w-2xl">
          {name}: every branch is a restaurant of its own, with its own login, staff, stock, orders and finance. Open a branch to work in it,
          or compare them side by side.
        </p>
      </div>
      {error && <div className="rounded border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{error}</div>}
      {data && branches.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-5 space-y-2">
          <h2 className="font-bold">Create your first branch</h2>
          <p className="text-xs text-muted max-w-xl">
            Give it a code and a name — for example DHA, “DHA Phase 6”. It gets its own database and its own login; set its menu up there,
            and every later branch starts from a copy of it.
          </p>
          <Link href={`/r/${slug}/branches`} className="inline-block rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg">
            Add a branch
          </Link>
        </section>
      ) : (
        <OwnerBranchesPanel slug={slug} />
      )}
      {branches.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-bold">Comparison · this month</h2>
          <BranchComparison slug={slug} />
        </section>
      )}
    </div>
  );
}
