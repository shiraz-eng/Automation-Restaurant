'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CURRENCIES } from '@automation-restaurant/shared';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import { BRANCH_COOKIE } from '@/lib/branchScope';

export type ManagedBranch = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  currency_code: string | null;
  phone: string | null;
  opening_hours: { text?: string } | null;
  status: 'active' | 'inactive' | 'archived';
  status_reason: string | null;
  is_default: boolean;
  created_at: string;
};
/** A portal login or a staff member (memberships); both can be limited to branches. */
export type BranchLogin = { id: string; name: string; status: string; branch_ids: string[] | null; kind: 'portal' | 'member'; detail?: string };

const TIMEZONES = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Qatar', 'Asia/Kolkata', 'Asia/Dhaka', 'Europe/London', 'America/New_York', 'UTC'];
const EMPTY = { code: '', name: '', address: '', city: '', country: '', timezone: '', currency_code: '', phone: '', hours: '' };
const EMPTY_LOGIN = { name: '', role: 'branch_manager', email: '', password: '' };
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const ERRORS: Record<string, string> = {
  forbidden: 'You are not allowed to do that.',
  branch_limit: 'Your plan includes one branch. Upgrade to Enterprise to add more.',
  default_branch: 'Make another branch the default first.',
  reason_required: 'Write a reason.',
  bad_timezone: 'That time zone is not recognised.',
  branch_not_active: 'Only an active branch can be the default.',
};
const explain = (msg: string) => {
  const key = Object.keys(ERRORS).find((k) => msg.startsWith(k));
  if (key) return ERRORS[key];
  if (/branches_code_key|duplicate key/.test(msg)) return 'Another branch already uses that code.';
  if (/branches_code_check/.test(msg)) return 'Codes are 2–12 capital letters, digits or dashes, e.g. DHA or KHI-01.';
  return msg;
};

export function BranchesManager({
  slug,
  branches,
  logins,
  canManage,
  multiEntitled,
  currentBranchId,
  canCreateLogins = false,
}: {
  slug: string;
  branches: ManagedBranch[];
  logins: BranchLogin[];
  canManage: boolean;
  multiEntitled: boolean;
  currentBranchId: string | null;
  /** Owner: show "Create a login for this branch" (opens Portals with the branch picked). */
  canCreateLogins?: boolean;
}) {
  const supabase = usePortalSupabase();
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusFor, setStatusFor] = useState<{ id: string; status: 'inactive' | 'archived' | 'active' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loginEdits, setLoginEdits] = useState<Record<string, string[]>>({});
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const [loginForm, setLoginForm] = useState(EMPTY_LOGIN);

  async function apiCall(path: string, body: Record<string, unknown>) {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ slug, ...body }),
    });
    return { ok: res.ok, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** The owner creates a sign-in for one branch's panel (POST /api/branch-logins). */
  async function createBranchLogin(b: ManagedBranch) {
    if (loginForm.name.trim().length < 2) return setError('Give the login a name.');
    if (loginForm.password && loginForm.password.length < 8) return setError('The password needs 8 characters or more — or leave it empty.');
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, body } = await apiCall('/api/branch-logins', {
      branch_id: b.id,
      full_name: loginForm.name.trim(),
      role: loginForm.role,
      ...(loginForm.email.trim() ? { email: loginForm.email.trim() } : {}),
      ...(loginForm.password ? { password: loginForm.password } : {}),
    });
    setBusy(false);
    if (!ok) return setError(String(body.message ?? body.error ?? 'Could not create the login.'));
    const login = body.login as { email: string; password?: string };
    setNotice(
      `${loginForm.name.trim()} can now sign in to the ${b.name} panel.\n  Sign in at: ${body.url}\n  Email:      ${login.email}\n  Password:   ${login.password ?? '(the one you typed)'}\n(Shown once — copy it now.) This login sees only ${b.name}.`,
    );
    setLoginFor(null);
    router.refresh();
  }

  async function resetLoginPassword(l: BranchLogin) {
    if (!window.confirm(`Give ${l.name} a new password? Their current one stops working.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, body } = await apiCall(`/api/branch-logins/${l.id}/password`, {});
    setBusy(false);
    if (!ok) return setError(String(body.message ?? body.error ?? 'Could not reset the password.'));
    setNotice(`New password for ${l.name}: ${body.password}\n(Shown once — copy it now.)`);
  }

  const activeCount = branches.filter((b) => b.status === 'active').length;
  const canAdd = canManage && (multiEntitled || activeCount < 1);

  function startEdit(b: ManagedBranch) {
    setCreating(false);
    setEditing(b.id);
    setForm({
      code: b.code, name: b.name, address: b.address ?? '', city: b.city ?? '', country: b.country ?? '',
      timezone: b.timezone ?? '', currency_code: b.currency_code ?? '', phone: b.phone ?? '', hours: b.opening_hours?.text ?? '',
    });
  }

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      setError(explain(e.message));
      return false;
    }
    setNotice(done);
    router.refresh();
    return true;
  }

  async function save() {
    if (!form.name.trim()) return setError('Give the branch a name.');
    const common = {
      p_name: form.name,
      p_address: form.address || null,
      p_city: form.city || null,
      p_country: form.country || null,
      p_timezone: form.timezone || null,
      p_currency_code: form.currency_code || null,
      p_phone: form.phone || null,
      p_opening_hours: form.hours.trim() ? { text: form.hours.trim() } : {},
    };
    const ok = editing
      ? await run(() => supabase.rpc('update_branch', { p_id: editing, ...common }), 'Branch saved.')
      : await run(() => supabase.rpc('create_branch', { p_code: form.code, ...common }), `Branch ${form.code.toUpperCase()} created.`);
    if (ok) {
      setEditing(null);
      setCreating(false);
      setForm(EMPTY);
    }
  }

  async function changeStatus() {
    if (!statusFor) return;
    const ok = await run(
      () => supabase.rpc('set_branch_status', { p_id: statusFor.id, p_status: statusFor.status, p_reason: reason || null }),
      statusFor.status === 'active' ? 'Branch reactivated.' : statusFor.status === 'archived' ? 'Branch archived.' : 'Branch deactivated.',
    );
    if (ok) {
      setStatusFor(null);
      setReason('');
    }
  }

  function workIn(id: string) {
    document.cookie = `${BRANCH_COOKIE}=${id}; path=/r/${slug}; max-age=31536000; samesite=lax`;
    window.location.assign(`/r/${slug}`);
  }

  const formCard = (
    <Card className="space-y-3">
      <h2 className="font-bold text-sm">{editing ? 'Edit branch' : 'New branch'}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code (DHA, KHI-01…)">
          <Input id="branch-code" value={form.code} disabled={!!editing} maxLength={12} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Name">
          <Input id="branch-name" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="BBQ Tonight — DHA" />
        </Field>
        <Field label="Phone">
          <Input id="branch-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Address">
          <Input id="branch-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label="City">
          <Input id="branch-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Field>
        <Field label="Country">
          <Input id="branch-country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </Field>
        <Field label="Time zone">
          <Select id="branch-tz" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            <option value="">Same as the restaurant</option>
            {TIMEZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Select id="branch-currency" value={form.currency_code} onChange={(e) => setForm({ ...form, currency_code: e.target.value })}>
            <option value="">Same as the restaurant</option>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Opening hours">
          <Input id="branch-hours" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} placeholder="Mon–Sun 12:00–24:00" />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : editing ? 'Save branch' : 'Create branch'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setEditing(null);
            setCreating(false);
            setForm(EMPTY);
          }}
        >
          Cancel
        </Button>
      </div>
    </Card>
  );

  return (
    <div className="space-y-6">
      {error && <div className="rounded border border-danger/40 bg-danger/10 p-2.5 text-xs text-danger">{error}</div>}
      {notice && <div className="rounded border border-ok/40 bg-ok/10 p-2.5 text-xs text-ok font-mono whitespace-pre-wrap">{notice}</div>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {activeCount} active branch{activeCount === 1 ? '' : 'es'}
          {!multiEntitled && ' · your plan includes one branch (Enterprise adds more)'}
        </p>
        {canAdd && !creating && !editing && (
          <Button
            onClick={() => {
              setCreating(true);
              setForm(EMPTY);
            }}
          >
            + Add branch
          </Button>
        )}
      </div>
      {(creating || editing) && formCard}

      <div className="grid gap-3 sm:grid-cols-2">
        {branches.map((b) => (
          <Card key={b.id} className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-bold">
                  {b.name} <span className="font-mono text-xs text-muted">{b.code}</span>
                </p>
                <p className="text-xs text-muted">{[b.address, b.city, b.country].filter(Boolean).join(', ') || 'No address yet'}</p>
              </div>
              <div className="flex flex-wrap gap-1 text-[10px] font-bold uppercase">
                {b.is_default && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">Default</span>}
                <span
                  className={`rounded px-1.5 py-0.5 ${b.status === 'active' ? 'bg-ok/10 text-ok' : b.status === 'inactive' ? 'bg-warn/10 text-warn' : 'bg-main text-muted'}`}
                >
                  {b.status}
                </span>
                {currentBranchId === b.id && <span className="rounded bg-main px-1.5 py-0.5 text-body">Working here</span>}
              </div>
            </div>
            <p className="text-xs text-muted">
              {b.timezone ?? 'Restaurant time zone'} · {b.currency_code ?? 'Restaurant currency'}
              {b.opening_hours?.text ? ` · ${b.opening_hours.text}` : ''}
              {b.phone ? ` · ${b.phone}` : ''}
            </p>
            {b.status !== 'active' && b.status_reason && <p className="text-xs text-warn">Reason: {b.status_reason}</p>}
            {canCreateLogins && (
              <div className="rounded border border-border p-2.5 space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Branch logins</p>
                {(() => {
                  const own = logins.filter((l) => (l.branch_ids ?? []).includes(b.id));
                  if (!own.length) return <p className="text-xs text-muted">No login of its own yet — only your owner panel sees this branch.</p>;
                  return own.map((l) => (
                    <div key={l.kind + l.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span>
                        <b>{l.name}</b>{' '}
                        <span className="text-muted">{l.kind === 'member' ? `${(l.detail ?? '').replace('_', ' ')} · signs in to the branch panel` : 'custom portal'}</span>
                      </span>
                      {l.kind === 'member' && (
                        <Button variant="ghost" disabled={busy} onClick={() => void resetLoginPassword(l)}>
                          Reset password
                        </Button>
                      )}
                    </div>
                  ));
                })()}
                {loginFor === b.id ? (
                  <div className="grid gap-2 sm:grid-cols-2 pt-1">
                    <Input id="bl-name" value={loginForm.name} onChange={(e) => setLoginForm({ ...loginForm, name: e.target.value })} placeholder="Name, e.g. Ali (DHA manager)" />
                    <Select id="bl-role" value={loginForm.role} onChange={(e) => setLoginForm({ ...loginForm, role: e.target.value })} aria-label="Role">
                      <option value="branch_manager">Branch manager — runs this branch</option>
                      <option value="cashier">Cashier</option>
                      <option value="chef">Kitchen</option>
                      <option value="waiter">Waiter</option>
                      <option value="accountant">Accountant</option>
                    </Select>
                    <Input id="bl-email" type="email" value={loginForm.email} onChange={(e) => setLoginForm({ ...loginForm, email: e.target.value })} placeholder="Login email (optional)" />
                    <Input id="bl-password" type="text" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} placeholder="Password (optional, 8+ characters)" />
                    <div className="flex gap-1.5 sm:col-span-2">
                      <Button disabled={busy} onClick={() => void createBranchLogin(b)}>
                        Create login
                      </Button>
                      <Button variant="ghost" onClick={() => setLoginFor(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  b.status === 'active' && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <Button onClick={() => { setLoginFor(b.id); setLoginForm(EMPTY_LOGIN); }}>Add branch login</Button>
                      <Link
                        href={`/r/${slug}/portals?branch=${b.id}`}
                        className="rounded px-3 py-1.5 text-xs font-semibold border border-border hover:bg-main"
                      >
                        Custom portal for this branch
                      </Link>
                    </div>
                  )
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {b.status === 'active' && currentBranchId !== b.id && (
                <Button variant="ghost" onClick={() => workIn(b.id)}>
                  Work in this branch
                </Button>
              )}
              {canManage && (
                <>
                  <Button variant="ghost" onClick={() => startEdit(b)}>
                    Edit
                  </Button>
                  {b.status === 'active' && !b.is_default && (
                    <Button variant="ghost" disabled={busy} onClick={() => void run(() => supabase.rpc('set_default_branch', { p_id: b.id }), `${b.name} is now the default branch.`)}>
                      Make default
                    </Button>
                  )}
                  {b.status === 'active' && !b.is_default && (
                    <Button variant="ghost" onClick={() => setStatusFor({ id: b.id, status: 'inactive' })}>
                      Deactivate
                    </Button>
                  )}
                  {b.status === 'inactive' && (
                    <>
                      <Button variant="ghost" onClick={() => setStatusFor({ id: b.id, status: 'active' })}>
                        Reactivate
                      </Button>
                      <Button variant="ghost" onClick={() => setStatusFor({ id: b.id, status: 'archived' })}>
                        Archive
                      </Button>
                    </>
                  )}
                </>
              )}
            </div>
            {statusFor?.id === b.id && (
              <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs space-y-2">
                <p className="font-semibold">
                  {statusFor.status === 'inactive'
                    ? `Deactivate ${b.name}? It stops taking orders; its history stays.`
                    : statusFor.status === 'archived'
                      ? `Archive ${b.name}? It disappears from the branch selector; its history stays in every report.`
                      : `Reactivate ${b.name}? It can take orders again.`}
                </p>
                {statusFor.status !== 'active' && (
                  <Input id="branch-status-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />
                )}
                <div className="flex gap-2">
                  <Button disabled={busy || (statusFor.status !== 'active' && !reason.trim())} onClick={() => void changeStatus()}>
                    Confirm
                  </Button>
                  <Button variant="ghost" onClick={() => setStatusFor(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      {canManage && logins.length > 0 && branches.length > 1 && (
        <section className="space-y-2">
          <h2 className="font-bold text-sm">Which branches each login may use</h2>
          <p className="text-xs text-muted">
            Tick none for every branch. A login limited to DHA cannot see or change Clifton&apos;s orders, cash or reports — the database
            enforces it.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="p-2.5 font-semibold">Login</th>
                  {branches.filter((b) => b.status !== 'archived').map((b) => (
                    <th key={b.id} className="p-2.5 font-semibold text-center">
                      {b.code}
                    </th>
                  ))}
                  <th className="p-2.5" />
                </tr>
              </thead>
              <tbody>
                {logins.map((l) => {
                  const ids = loginEdits[l.id] ?? l.branch_ids ?? [];
                  const changed = loginEdits[l.id] !== undefined;
                  return (
                    <tr key={l.id} className="border-b border-border/60 last:border-0">
                      <td className="p-2.5 font-semibold">
                        {l.name}
                        <span className="ml-1.5 rounded bg-main px-1.5 py-0.5 text-[10px] font-normal text-muted">
                          {l.kind === 'member' ? (l.detail ?? 'staff') : 'portal'}
                        </span>
                        <span className="ml-1.5 font-normal text-muted">{ids.length === 0 ? 'all branches' : `${ids.length} branch${ids.length === 1 ? '' : 'es'}`}</span>
                      </td>
                      {branches.filter((b) => b.status !== 'archived').map((b) => (
                        <td key={b.id} className="p-2.5 text-center">
                          <input
                            type="checkbox"
                            aria-label={`${l.name} may use ${b.name}`}
                            checked={ids.includes(b.id)}
                            onChange={(e) =>
                              setLoginEdits({ ...loginEdits, [l.id]: e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id) })
                            }
                          />
                        </td>
                      ))}
                      <td className="p-2.5 text-right">
                        {changed && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(() => supabase.rpc('set_login_branches', { p_kind: l.kind, p_id: l.id, p_branch_ids: ids }), `${l.name} updated.`).then(
                                (ok) => ok && setLoginEdits((m) => { const n = { ...m }; delete n[l.id]; return n; }),
                              )
                            }
                          >
                            Save
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted">A login picks up a change the next time it loads a page.</p>
        </section>
      )}
    </div>
  );
}
