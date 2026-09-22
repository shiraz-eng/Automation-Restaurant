'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createControlPlaneBrowserClient } from '@/lib/supabase/control-plane-client';
import { AdminButton, AdminCard, AdminField, AdminInput, AdminTextarea } from '../_components/ui';
import { ENFORCEABLE_FEATURES, ALL_FEATURE_KEYS, type FeatureKey } from '@automation-restaurant/shared';

export type PlanDbRow = {
  id: string;
  tier: string;
  name: string;
  blurb: string | null;
  price_monthly_cents: number | null;
  price_annual_cents: number | null;
  currency: string;
  limits: { users?: string; branches?: string; tables?: string; support?: string };
  highlights: string[];
  features: string[];
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  is_active: boolean;
  sort_order: number;
};

const MARKETING_ONLY_FEATURES = ALL_FEATURE_KEYS.filter((f) => !ENFORCEABLE_FEATURES.includes(f));

function blank(sortOrder: number): PlanDbRow {
  return {
    id: '',
    tier: '',
    name: '',
    blurb: '',
    price_monthly_cents: 0,
    price_annual_cents: 0,
    currency: 'usd',
    limits: { users: '', branches: '', tables: '', support: '' },
    highlights: [],
    features: [],
    stripe_price_id_monthly: '',
    stripe_price_id_annual: '',
    is_active: true,
    sort_order: sortOrder,
  };
}

function PlanEditor({ plan, onDone }: { plan: PlanDbRow; onDone: () => void }) {
  const supabase = createControlPlaneBrowserClient();
  const isNew = !plan.id;
  const [draft, setDraft] = useState(plan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof PlanDbRow>(key: K, value: PlanDbRow[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function toggleFeature(key: FeatureKey) {
    setDraft((d) => ({
      ...d,
      features: d.features.includes(key) ? d.features.filter((f) => f !== key) : [...d.features, key],
    }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    const payload = {
      tier: draft.tier.trim(),
      name: draft.name.trim(),
      blurb: draft.blurb?.trim() || null,
      price_monthly_cents: draft.price_monthly_cents,
      price_annual_cents: draft.price_annual_cents,
      limits: draft.limits,
      highlights: draft.highlights,
      features: draft.features,
      stripe_price_id_monthly: draft.stripe_price_id_monthly?.trim() || null,
      stripe_price_id_annual: draft.stripe_price_id_annual?.trim() || null,
      is_active: draft.is_active,
      sort_order: draft.sort_order,
    };
    const { error: e } = isNew
      ? await supabase.from('plans').insert(payload)
      : await supabase.from('plans').update(payload).eq('id', draft.id);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    onDone();
  }

  async function deactivate() {
    if (!confirm(`Deactivate "${draft.name}"? It will disappear from pricing/checkout but existing subscribers keep it.`)) return;
    setBusy(true);
    const { error: e } = await supabase.from('plans').update({ is_active: false }).eq('id', draft.id);
    setBusy(false);
    if (e) setError(e.message);
    else onDone();
  }

  return (
    <AdminCard className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Tier key (unique, e.g. starter)">
          <AdminInput value={draft.tier} onChange={(e) => set('tier', e.target.value)} disabled={!isNew} placeholder="tier_key" />
        </AdminField>
        <AdminField label="Display name">
          <AdminInput value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Starter" />
        </AdminField>
      </div>
      <AdminField label="Blurb">
        <AdminInput value={draft.blurb ?? ''} onChange={(e) => set('blurb', e.target.value)} placeholder="For small restaurants and cafés." />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Price monthly ($, blank = contact sales)">
          <AdminInput
            type="number"
            value={draft.price_monthly_cents == null ? '' : draft.price_monthly_cents / 100}
            onChange={(e) => set('price_monthly_cents', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))}
          />
        </AdminField>
        <AdminField label="Price annual ($/mo billed yearly, blank = contact sales)">
          <AdminInput
            type="number"
            value={draft.price_annual_cents == null ? '' : draft.price_annual_cents / 100}
            onChange={(e) => set('price_annual_cents', e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))}
          />
        </AdminField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Stripe price ID — monthly">
          <AdminInput value={draft.stripe_price_id_monthly ?? ''} onChange={(e) => set('stripe_price_id_monthly', e.target.value)} placeholder="price_..." />
        </AdminField>
        <AdminField label="Stripe price ID — annual">
          <AdminInput value={draft.stripe_price_id_annual ?? ''} onChange={(e) => set('stripe_price_id_annual', e.target.value)} placeholder="price_..." />
        </AdminField>
      </div>
      <p className="text-[11px] text-ink-muted -mt-1">
        Changing displayed price alone does not change what Stripe charges — Stripe prices are immutable, so a real price
        change needs a new Stripe Price object; paste its ID here.
      </p>

      <div className="grid grid-cols-4 gap-3">
        <AdminField label="Users limit">
          <AdminInput value={draft.limits.users ?? ''} onChange={(e) => set('limits', { ...draft.limits, users: e.target.value })} />
        </AdminField>
        <AdminField label="Branches limit">
          <AdminInput value={draft.limits.branches ?? ''} onChange={(e) => set('limits', { ...draft.limits, branches: e.target.value })} />
        </AdminField>
        <AdminField label="Tables limit">
          <AdminInput value={draft.limits.tables ?? ''} onChange={(e) => set('limits', { ...draft.limits, tables: e.target.value })} />
        </AdminField>
        <AdminField label="Support">
          <AdminInput value={draft.limits.support ?? ''} onChange={(e) => set('limits', { ...draft.limits, support: e.target.value })} />
        </AdminField>
      </div>

      <AdminField label="Highlights (one per line — shown on the pricing card)">
        <AdminTextarea
          rows={4}
          value={draft.highlights.join('\n')}
          onChange={(e) => set('highlights', e.target.value.split('\n'))}
        />
      </AdminField>

      <div>
        <div className="text-xs font-semibold mb-1.5">Enforced features</div>
        <p className="text-[11px] text-ink-muted mb-2">These are actually gated in the app — checking one really unlocks it.</p>
        <div className="flex flex-wrap gap-3">
          {ENFORCEABLE_FEATURES.map((f) => (
            <label key={f} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={draft.features.includes(f)} onChange={() => toggleFeature(f)} />
              {f}
            </label>
          ))}
        </div>
        <div className="text-xs font-semibold mb-1.5 mt-3">Marketing-only features</div>
        <p className="text-[11px] text-ink-muted mb-2">Not enforced anywhere yet — checking one only changes what's displayed as included.</p>
        <div className="flex flex-wrap gap-3">
          {MARKETING_ONLY_FEATURES.map((f) => (
            <label key={f} className="flex items-center gap-1.5 text-xs text-ink-muted">
              <input type="checkbox" checked={draft.features.includes(f)} onChange={() => toggleFeature(f)} />
              {f}
            </label>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Sort order">
          <AdminInput type="number" value={draft.sort_order} onChange={(e) => set('sort_order', Number(e.target.value))} />
        </AdminField>
        <label className="flex items-center gap-2 text-xs font-semibold self-end pb-2">
          <input type="checkbox" checked={draft.is_active} onChange={(e) => set('is_active', e.target.checked)} />
          Active (visible on pricing/checkout)
        </label>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        <AdminButton onClick={save} disabled={busy || !draft.tier.trim() || !draft.name.trim()}>
          {busy ? 'Saving…' : isNew ? 'Create plan' : 'Save changes'}
        </AdminButton>
        <AdminButton variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </AdminButton>
        {!isNew && draft.is_active && (
          <button onClick={deactivate} disabled={busy} className="text-red-400 text-xs font-semibold ml-auto">
            Deactivate
          </button>
        )}
      </div>
    </AdminCard>
  );
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function PlansManager({ plans }: { plans: PlanDbRow[] }) {
  const router = useRouter();
  const supabase = createControlPlaneBrowserClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  function refresh() {
    setEditingId(null);
    setCreating(false);
    router.refresh();
  }

  async function resyncEntitlements() {
    setResyncing(true);
    setResyncMsg(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch(`${API}/api/admin/resync-entitlements`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
    });
    const body = await res.json().catch(() => ({}));
    setResyncing(false);
    setResyncMsg(res.ok ? `Synced ${body.synced} tenant(s)${body.failed ? `, ${body.failed} failed` : ''}.` : (body.message ?? 'Resync failed.'));
  }

  if (creating) {
    return <PlanEditor plan={blank(plans.length)} onDone={refresh} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <AdminButton variant="ghost" onClick={resyncEntitlements} disabled={resyncing}>
          {resyncing ? 'Syncing…' : 'Resync all tenants’ entitlements'}
        </AdminButton>
        {resyncMsg && <span className="text-xs text-ink-muted">{resyncMsg}</span>}
      </div>
      <p className="text-[11px] text-ink-muted -mt-2">
        Push every active tenant&rsquo;s current plan features into their own project — run this after changing a
        plan&rsquo;s features so it takes effect immediately instead of waiting for their next subscription event.
      </p>
      {plans.map((p) =>
        editingId === p.id ? (
          <PlanEditor key={p.id} plan={p} onDone={refresh} />
        ) : (
          <AdminCard key={p.id} className={`flex items-center justify-between gap-3 ${!p.is_active ? 'opacity-50' : ''}`}>
            <div>
              <div className="font-bold text-sm flex items-center gap-2">
                {p.name}
                <span className="text-[10px] font-mono text-ink-muted">{p.tier}</span>
                {!p.is_active && <span className="text-[10px] font-bold text-red-400">INACTIVE</span>}
              </div>
              <div className="text-ink-muted text-xs">
                {p.price_monthly_cents == null ? 'Contact sales' : `$${p.price_monthly_cents / 100}/mo`}
                {p.price_annual_cents != null && ` · $${p.price_annual_cents / 100}/mo annual`}
                {' · '}
                {p.features.length} feature{p.features.length === 1 ? '' : 's'}
              </div>
            </div>
            <AdminButton variant="ghost" onClick={() => setEditingId(p.id)}>
              Edit
            </AdminButton>
          </AdminCard>
        ),
      )}
      <AdminButton variant="ghost" onClick={() => setCreating(true)}>
        + Add plan
      </AdminButton>
    </div>
  );
}
