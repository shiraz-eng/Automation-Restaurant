'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import {
  CHANNEL_LABEL,
  DAY_LABEL,
  ORDER_TYPE_LABEL,
  STATUS_LABEL,
  STATUS_STYLE,
  TYPE_LABEL,
  dealStatus,
  discountPct,
  itemLabel,
  itemPrice,
  money,
  regularValue,
  timeLabel,
  validityLabel,
  type DealAvail,
  type DealComponent,
  type DealLifecycle,
  type DealOptionGroup,
  type DealRow,
  type DealType,
  type MenuPick,
  type OrderType,
  type SalesChannel,
} from './dealTypes';

const STEPS = [
  'Basic Info',
  'Select Items',
  'Offer & Pricing',
  'Rules',
  'Availability',
  'Schedule',
  'Customer Display',
  'Review & Publish',
] as const;

const MAX_DISCOUNT_PCT = 70;
const FOOD_COST_LIMIT_PCT = 45;

type Draft = {
  name: string;
  description: string;
  deal_type: DealType;
  image_url: string;
  price: string;
  components: DealComponent[];
  groups: DealOptionGroup[];
  min_qty: string;
  max_qty: string;
  usage_limit: string;
  order_types: OrderType[];
  sales_channels: SalesChannel[];
  start_date: string;
  end_date: string;
  all_days: boolean;
  active_days: number[];
  start_time: string;
  end_time: string;
  tagline: string;
  badge: string;
  show_savings: boolean;
};

function toLocalDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDeal(d: DealRow | null): Draft {
  return {
    name: d?.name ?? '',
    description: d?.description ?? '',
    deal_type: d?.deal_type ?? 'combo',
    image_url: d?.image_url ?? '',
    price: d ? (d.price_cents / 100).toString() : '',
    components: (d?.deal_components ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({ menu_item_id: c.menu_item_id, variant_id: c.variant_id, qty: c.qty, sort_order: c.sort_order })),
    groups: (d?.deal_option_groups ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((g) => ({
        name: g.name,
        min_select: g.min_select,
        max_select: g.max_select,
        sort_order: g.sort_order,
        deal_option_items: g.deal_option_items
          .slice()
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((i) => ({
            menu_item_id: i.menu_item_id,
            variant_id: i.variant_id,
            qty: i.qty,
            price_adjustment_cents: i.price_adjustment_cents,
            is_default: i.is_default,
            sort_order: i.sort_order,
          })),
      })),
    min_qty: String(d?.min_qty ?? 1),
    max_qty: d?.max_qty != null ? String(d.max_qty) : '',
    usage_limit: d?.usage_limit != null ? String(d.usage_limit) : '',
    order_types: d?.order_types ?? ['dine_in', 'takeaway', 'delivery'],
    sales_channels: d?.sales_channels ?? ['customer_portal', 'pos'],
    start_date: toLocalDate(d?.starts_at ?? null),
    end_date: toLocalDate(d?.ends_at ?? null),
    all_days: !d?.active_days || d.active_days.length === 0 || d.active_days.length === 7,
    active_days: d?.active_days && d.active_days.length ? d.active_days : [0, 1, 2, 3, 4, 5, 6],
    start_time: d?.start_time?.slice(0, 5) ?? '',
    end_time: d?.end_time?.slice(0, 5) ?? '',
    tagline: d?.tagline ?? '',
    badge: d?.badge ?? '',
    show_savings: d?.show_savings ?? true,
  };
}

/**
 * Create / edit a deal in eight steps, with the customer's view and the
 * deal summary live alongside. Writes go straight to the deals tables
 * under RLS (deals.create / deals.update); the rules it sets — schedule,
 * channels, per-order limits, usage limit — are enforced by the database
 * when an order is placed, not by this form.
 */
export function DealEditor({
  deal,
  menu,
  currency,
  availability,
  canSave,
  canViewCost,
  onClose,
  onSaved,
}: {
  deal: DealRow | null;
  menu: MenuPick[];
  currency: string;
  availability: DealAvail | null;
  canSave: boolean;
  canViewCost: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const supabase = usePortalSupabase();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => fromDeal(deal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [cost, setCost] = useState<{ cents: number; known: boolean } | null>(null);
  const [pickItem, setPickItem] = useState('');

  const menuById = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const regular = regularValue(menuById, draft.components, draft.groups);
  const priceCents = Math.round((parseFloat(draft.price) || 0) * 100);
  const savings = Math.max(regular - priceCents, 0);
  const pct = discountPct(regular, priceCents);
  const foodCostPct = cost && priceCents > 0 ? Math.round((cost.cents / priceCents) * 1000) / 10 : null;

  // Food cost of the current selection (fixed items + each group's default).
  const costKey = JSON.stringify([
    draft.components,
    draft.groups.map((g) => g.deal_option_items.filter((i) => i.is_default)),
  ]);
  useEffect(() => {
    if (!canViewCost) return;
    const comps = [
      ...draft.components,
      ...draft.groups.flatMap((g) => g.deal_option_items.filter((i) => i.is_default)),
    ].map((c) => ({ menu_item_id: c.menu_item_id, variant_id: c.variant_id, qty: c.qty }));
    if (comps.length === 0) {
      setCost(null);
      return;
    }
    let cancelled = false;
    void supabase.rpc('deal_cost_estimate', { p_components: comps }).then(({ data }) => {
      if (cancelled) return;
      const row = (Array.isArray(data) ? data[0] : data) as { cost_cents: number; cost_known: boolean } | null;
      setCost(row ? { cents: row.cost_cents, known: row.cost_known } : null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costKey, canViewCost, supabase]);

  const itemCount =
    draft.components.reduce((s, c) => s + c.qty, 0) + draft.groups.reduce((s, g) => s + Math.max(g.min_select, 1), 0);

  const checks: { ok: boolean; label: string; blocking: boolean }[] = [
    { ok: draft.name.trim().length > 1, label: 'Deal has a name', blocking: true },
    { ok: draft.components.length + draft.groups.length > 0, label: 'At least one item is included', blocking: true },
    { ok: priceCents > 0, label: 'Deal price is set', blocking: true },
    { ok: regular === 0 || priceCents < regular, label: 'Deal price is below regular value', blocking: false },
    {
      ok: draft.components.every((c) => c.menu_item_id && menuById.has(c.menu_item_id)),
      label: 'Required items exist on the menu',
      blocking: true,
    },
    { ok: pct == null || pct <= MAX_DISCOUNT_PCT, label: `Discount is within limits (≤ ${MAX_DISCOUNT_PCT}%)`, blocking: false },
    ...(canViewCost && foodCostPct != null
      ? [{ ok: foodCostPct <= FOOD_COST_LIMIT_PCT, label: `Food cost is within threshold (≤ ${FOOD_COST_LIMIT_PCT}%)`, blocking: false }]
      : []),
    {
      ok: draft.order_types.length > 0 && draft.sales_channels.length > 0,
      label: 'Offered on at least one order type and channel',
      blocking: true,
    },
    {
      ok: !draft.max_qty || Number(draft.max_qty) >= Number(draft.min_qty || 1),
      label: 'Max per order is not below min',
      blocking: true,
    },
    { ok: !draft.start_date || !draft.end_date || draft.end_date >= draft.start_date, label: 'End date is after start date', blocking: true },
  ];
  const blocked = checks.some((c) => c.blocking && !c.ok);

  const startsAtIso = draft.start_date ? new Date(`${draft.start_date}T00:00`).toISOString() : null;
  const endsAtIso = draft.end_date ? new Date(`${draft.end_date}T23:59:59`).toISOString() : null;
  const startsInFuture = !!startsAtIso && new Date(startsAtIso) > new Date();

  async function uploadImage(file: File) {
    setUploading(true);
    setError(null);
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `deals/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('menu-images').upload(path, file, { upsert: true, contentType: file.type });
    setUploading(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    set('image_url', supabase.storage.from('menu-images').getPublicUrl(path).data.publicUrl);
  }

  async function save(lifecycle: DealLifecycle) {
    if (blocked) {
      setError('Fix the items marked in Validation first.');
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);
    const row = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      deal_type: draft.deal_type,
      image_url: draft.image_url.trim() || null,
      price_cents: priceCents,
      status: lifecycle,
      min_qty: Math.max(1, parseInt(draft.min_qty, 10) || 1),
      max_qty: draft.max_qty ? Math.max(1, parseInt(draft.max_qty, 10)) : null,
      usage_limit: draft.usage_limit ? Math.max(1, parseInt(draft.usage_limit, 10)) : null,
      order_types: draft.order_types,
      sales_channels: draft.sales_channels,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      active_days: draft.all_days ? null : [...draft.active_days].sort(),
      start_time: draft.start_time || null,
      end_time: draft.end_time || null,
      tagline: draft.tagline.trim() || null,
      badge: draft.badge.trim() || null,
      show_savings: draft.show_savings,
    };
    try {
      let id = deal?.id ?? null;
      if (id) {
        const { error: e } = await supabase.from('deals').update(row).eq('id', id);
        if (e) throw e;
        // Replace the contents: simplest correct way to reorder/remove.
        const { error: d1 } = await supabase.from('deal_components').delete().eq('deal_id', id);
        if (d1) throw d1;
        const { error: d2 } = await supabase.from('deal_option_groups').delete().eq('deal_id', id);
        if (d2) throw d2;
      } else {
        const { data, error: e } = await supabase.from('deals').insert(row).select('id').single();
        if (e || !data) throw e ?? new Error('Could not create the deal.');
        id = data.id as string;
      }
      if (draft.components.length) {
        const { error: e } = await supabase.from('deal_components').insert(
          draft.components.map((c, i) => ({
            deal_id: id,
            menu_item_id: c.menu_item_id,
            variant_id: c.variant_id,
            qty: c.qty,
            sort_order: i,
          })),
        );
        if (e) throw e;
      }
      for (const [gi, g] of draft.groups.entries()) {
        const { data: grp, error: e } = await supabase
          .from('deal_option_groups')
          .insert({ deal_id: id, name: g.name.trim() || `Choice ${gi + 1}`, min_select: g.min_select, max_select: g.max_select, sort_order: gi })
          .select('id')
          .single();
        if (e || !grp) throw e ?? new Error('Could not save a choice group.');
        if (g.deal_option_items.length) {
          const { error: e2 } = await supabase.from('deal_option_items').insert(
            g.deal_option_items.map((it, ii) => ({
              group_id: grp.id,
              menu_item_id: it.menu_item_id,
              variant_id: it.variant_id,
              qty: it.qty,
              price_adjustment_cents: it.price_adjustment_cents,
              is_default: it.is_default,
              sort_order: ii,
            })),
          );
          if (e2) throw e2;
        }
      }
      onSaved(id!);
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Could not save the deal.');
    } finally {
      setBusy(false);
    }
  }

  // ── item pickers ──
  function addComponent(value: string) {
    if (!value) return;
    const [itemId, variantId] = value.split(':');
    setDraft((d) => {
      const existing = d.components.findIndex((c) => c.menu_item_id === itemId && (c.variant_id ?? '') === (variantId ?? ''));
      if (existing >= 0) {
        const next = [...d.components];
        next[existing] = { ...next[existing], qty: next[existing].qty + 1 };
        return { ...d, components: next };
      }
      return {
        ...d,
        components: [...d.components, { menu_item_id: itemId, variant_id: variantId || null, qty: 1, sort_order: d.components.length }],
      };
    });
    setPickItem('');
  }
  const pickerOptions = menu.flatMap((m) =>
    m.menu_variants.length > 1
      ? m.menu_variants.map((v) => ({ value: `${m.id}:${v.id}`, label: `${m.name} · ${v.name}` }))
      : [{ value: `${m.id}:${m.menu_variants[0]?.id ?? ''}`, label: m.name }],
  );

  const preview = (
    <div className="rounded-2xl border border-border bg-surface overflow-hidden shadow-sm">
      <div className="aspect-[4/3] bg-main relative">
        {draft.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={draft.image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full grid place-items-center text-muted text-[11px]">No image yet</div>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        {draft.badge.trim() && (
          <span className="inline-block rounded bg-primary/15 text-primary px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide">
            {draft.badge.trim()}
          </span>
        )}
        <div className="font-black text-sm uppercase leading-tight">{draft.name.trim() || 'Deal name'}</div>
        {draft.tagline.trim() && <div className="text-[11px] text-muted">{draft.tagline.trim()}</div>}
        <div className="text-[11px] text-muted leading-snug">
          {[
            ...draft.components.map((c) => `${c.qty > 1 ? `${c.qty}× ` : ''}${itemLabel(menuById, c.menu_item_id, c.variant_id)}`),
            ...draft.groups.map((g) => `Choice of ${g.name || 'item'}`),
          ].join(', ') || 'Add items to this deal'}
        </div>
        <div className="flex items-baseline gap-2 pt-1">
          {draft.show_savings && savings > 0 && (
            <span className="text-[11px] text-muted line-through">{money(regular, currency)}</span>
          )}
          <span className="font-black text-base">{money(priceCents, currency)}</span>
        </div>
        {draft.show_savings && savings > 0 && (
          <span className="inline-block rounded bg-ok/15 text-ok px-1.5 py-0.5 text-[10px] font-bold">
            SAVE {money(savings, currency)}
          </span>
        )}
        <div className="mt-2 rounded-lg bg-primary text-primary-fg text-center text-xs font-bold py-2">Add to cart</div>
      </div>
    </div>
  );

  const derivedStatus = deal ? dealStatus(deal) : 'draft';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <button onClick={onClose} className="text-xs text-muted hover:text-body inline-flex items-center gap-1">
            <ChevronLeft size={13} /> Deals &amp; Combos
          </button>
          <h1 className="text-xl font-black">{deal ? `Edit ${deal.name}` : 'Create New Deal'}</h1>
        </div>
        {deal && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLE[derivedStatus]}`}>
            {STATUS_LABEL[derivedStatus]}
          </span>
        )}
      </div>

      {/* Stepper */}
      <Card className="p-3 overflow-x-auto">
        <ol className="flex items-center gap-1 min-w-max">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1">
              <button
                onClick={() => setStep(i)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${
                  i === step ? 'bg-primary text-primary-fg' : i < step ? 'text-body' : 'text-muted'
                }`}
              >
                <span
                  className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                    i < step ? 'bg-body text-surface' : i === step ? 'bg-primary-fg text-primary' : 'border border-border'
                  }`}
                >
                  {i < step ? <Check size={10} /> : i + 1}
                </span>
                {label}
              </button>
              {i < STEPS.length - 1 && <ChevronRight size={12} className="text-muted" />}
            </li>
          ))}
        </ol>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="text-[10px] font-bold uppercase tracking-wide text-primary mb-3">
              Step {step + 1} — {STEPS[step]}
            </div>

            {step === 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Deal name">
                  <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Family Feast" />
                </Field>
                <Field label="Type">
                  <Select value={draft.deal_type} onChange={(e) => set('deal_type', e.target.value as DealType)}>
                    {(Object.keys(TYPE_LABEL) as DealType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Description">
                    <textarea
                      value={draft.description}
                      onChange={(e) => set('description', e.target.value)}
                      rows={3}
                      placeholder="Family bundle of crispy chicken, fries, coleslaw & a soft drink"
                      className="w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                    />
                  </Field>
                </div>
                <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
                  {draft.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={draft.image_url} alt="" className="h-16 w-16 rounded-lg object-cover border border-border" />
                  )}
                  <label className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-semibold cursor-pointer hover:bg-main">
                    <ImagePlus size={14} /> {uploading ? 'Uploading…' : draft.image_url ? 'Replace image' : 'Upload image'}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])}
                    />
                  </label>
                  {draft.image_url && (
                    <button onClick={() => set('image_url', '')} className="text-[11px] text-muted hover:text-danger">
                      Remove
                    </button>
                  )}
                  {deal?.ref_code && <span className="text-[11px] text-muted font-mono ml-auto">Ref {deal.ref_code}</span>}
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <div className="text-xs font-bold mb-2">Included items</div>
                  <div className="space-y-1.5">
                    {draft.components.map((c, i) => {
                      const m = c.menu_item_id ? menuById.get(c.menu_item_id) : null;
                      return (
                        <div key={i} className="flex items-center gap-2 rounded-lg border border-border p-2">
                          {m?.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={m.image_url} alt="" className="h-9 w-9 rounded object-cover" />
                          ) : (
                            <div className="h-9 w-9 rounded bg-main" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold truncate">{itemLabel(menuById, c.menu_item_id, c.variant_id)}</div>
                            <div className="text-[10px] text-muted">
                              {money(itemPrice(menuById, c.menu_item_id, c.variant_id), currency)} each
                            </div>
                          </div>
                          <span className="text-[11px] text-muted">Qty</span>
                          <Input
                            type="number"
                            min="1"
                            value={c.qty}
                            onChange={(e) => {
                              const q = Math.max(1, parseInt(e.target.value, 10) || 1);
                              setDraft((d) => ({ ...d, components: d.components.map((x, j) => (j === i ? { ...x, qty: q } : x)) }));
                            }}
                            className="w-16 text-right"
                          />
                          <button
                            onClick={() => setDraft((d) => ({ ...d, components: d.components.filter((_, j) => j !== i) }))}
                            className="text-muted hover:text-danger"
                            aria-label="Remove item"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Select value={pickItem} onChange={(e) => addComponent(e.target.value)} className="max-w-sm">
                      <option value="">+ Add menu item…</option>
                      {pickerOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs font-bold">Choice groups (customer picks)</div>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          groups: [...d.groups, { name: '', min_select: 1, max_select: 1, sort_order: d.groups.length, deal_option_items: [] }],
                        }))
                      }
                    >
                      <Plus size={12} className="inline -mt-0.5" /> Add choice group
                    </Button>
                  </div>
                  {draft.groups.length === 0 && (
                    <p className="text-muted text-[11px]">
                      Optional — e.g. &ldquo;Choose your drink&rdquo;, where the customer picks one of several items.
                    </p>
                  )}
                  <div className="space-y-2">
                    {draft.groups.map((g, gi) => (
                      <div key={gi} className="rounded-lg border border-border p-2.5 space-y-2">
                        <div className="flex flex-wrap items-end gap-2">
                          <Field label="Group name">
                            <Input
                              value={g.name}
                              onChange={(e) =>
                                setDraft((d) => ({ ...d, groups: d.groups.map((x, j) => (j === gi ? { ...x, name: e.target.value } : x)) }))
                              }
                              placeholder="Choose your drink"
                              className="w-48"
                            />
                          </Field>
                          <Field label="Pick at least">
                            <Input
                              type="number"
                              min="0"
                              value={g.min_select}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  groups: d.groups.map((x, j) => (j === gi ? { ...x, min_select: Math.max(0, parseInt(e.target.value, 10) || 0) } : x)),
                                }))
                              }
                              className="w-20"
                            />
                          </Field>
                          <Field label="At most">
                            <Input
                              type="number"
                              min="1"
                              value={g.max_select ?? ''}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  groups: d.groups.map((x, j) =>
                                    j === gi ? { ...x, max_select: e.target.value ? Math.max(1, parseInt(e.target.value, 10)) : null } : x,
                                  ),
                                }))
                              }
                              className="w-20"
                            />
                          </Field>
                          <button
                            onClick={() => setDraft((d) => ({ ...d, groups: d.groups.filter((_, j) => j !== gi) }))}
                            className="ml-auto text-muted hover:text-danger pb-2"
                            aria-label="Remove group"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {g.deal_option_items.map((it, ii) => (
                          <div key={ii} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="flex-1 min-w-[140px] truncate">{itemLabel(menuById, it.menu_item_id, it.variant_id)}</span>
                            <span className="text-[11px] text-muted">Extra</span>
                            <Input
                              type="number"
                              step="0.01"
                              value={(it.price_adjustment_cents / 100).toString()}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  groups: d.groups.map((x, j) =>
                                    j === gi
                                      ? {
                                          ...x,
                                          deal_option_items: x.deal_option_items.map((y, k) =>
                                            k === ii ? { ...y, price_adjustment_cents: Math.round((parseFloat(e.target.value) || 0) * 100) } : y,
                                          ),
                                        }
                                      : x,
                                  ),
                                }))
                              }
                              className="w-20 text-right"
                            />
                            <label className="flex items-center gap-1 text-[11px]">
                              <input
                                type="checkbox"
                                checked={it.is_default}
                                onChange={(e) =>
                                  setDraft((d) => ({
                                    ...d,
                                    groups: d.groups.map((x, j) =>
                                      j === gi
                                        ? { ...x, deal_option_items: x.deal_option_items.map((y, k) => (k === ii ? { ...y, is_default: e.target.checked } : y)) }
                                        : x,
                                    ),
                                  }))
                                }
                              />
                              Default
                            </label>
                            <button
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  groups: d.groups.map((x, j) =>
                                    j === gi ? { ...x, deal_option_items: x.deal_option_items.filter((_, k) => k !== ii) } : x,
                                  ),
                                }))
                              }
                              className="text-muted hover:text-danger"
                              aria-label="Remove option"
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                        <Select
                          value=""
                          onChange={(e) => {
                            const [itemId, variantId] = e.target.value.split(':');
                            if (!itemId) return;
                            setDraft((d) => ({
                              ...d,
                              groups: d.groups.map((x, j) =>
                                j === gi
                                  ? {
                                      ...x,
                                      deal_option_items: [
                                        ...x.deal_option_items,
                                        {
                                          menu_item_id: itemId,
                                          variant_id: variantId || null,
                                          qty: 1,
                                          price_adjustment_cents: 0,
                                          is_default: x.deal_option_items.length === 0,
                                          sort_order: x.deal_option_items.length,
                                        },
                                      ],
                                    }
                                  : x,
                              ),
                            }));
                          }}
                          className="max-w-xs"
                        >
                          <option value="">+ Add option…</option>
                          {pickerOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <div className="text-xs font-bold">Pricing</div>
                  <dl className="text-xs space-y-1.5">
                    <div className="flex justify-between">
                      <dt className="text-muted">Regular menu value</dt>
                      <dd className="font-semibold tabular-nums">{money(regular, currency)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted">Deal price</dt>
                      <dd>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={draft.price}
                          onChange={(e) => set('price', e.target.value)}
                          className="w-32 text-right font-bold"
                        />
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted">Customer savings</dt>
                      <dd className="font-semibold tabular-nums text-ok">{money(savings, currency)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted">Effective discount</dt>
                      <dd className="font-semibold tabular-nums">{pct != null ? `${pct}%` : '—'}</dd>
                    </div>
                  </dl>

                  {canViewCost && (
                    <div className="mt-3 rounded-lg border border-border p-3">
                      <div className="text-xs font-bold mb-1.5">Profitability analysis</div>
                      {cost ? (
                        <dl className="text-xs space-y-1">
                          <div className="flex justify-between">
                            <dt className="text-muted">Estimated food cost</dt>
                            <dd className="tabular-nums">{money(cost.cents, currency)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted">Estimated gross profit</dt>
                            <dd className="tabular-nums">{money(priceCents - cost.cents, currency)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt className="text-muted">Food cost %</dt>
                            <dd className="tabular-nums">{foodCostPct != null ? `${foodCostPct}%` : '—'}</dd>
                          </div>
                          <div className="flex justify-between items-center">
                            <dt className="text-muted">Margin status</dt>
                            <dd>
                              {foodCostPct == null ? (
                                '—'
                              ) : foodCostPct <= 35 ? (
                                <span className="rounded bg-ok/15 text-ok px-1.5 py-0.5 text-[10px] font-bold">Healthy</span>
                              ) : foodCostPct <= FOOD_COST_LIMIT_PCT ? (
                                <span className="rounded bg-warn/15 text-warn px-1.5 py-0.5 text-[10px] font-bold">Watch</span>
                              ) : (
                                <span className="rounded bg-danger/15 text-danger px-1.5 py-0.5 text-[10px] font-bold">Low margin</span>
                              )}
                            </dd>
                          </div>
                          {!cost.known && (
                            <p className="text-[10px] text-muted pt-1">Some items have no recipe, so their cost isn&rsquo;t counted.</p>
                          )}
                        </dl>
                      ) : (
                        <p className="text-muted text-[11px]">
                          {draft.components.length + draft.groups.length === 0
                            ? 'Add items to see the estimated food cost.'
                            : 'Cost estimate isn’t available right now.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-border p-3">
                  <div className="text-xs font-bold mb-2">Validation check</div>
                  <ul className="space-y-1.5">
                    {checks.map((c) => (
                      <li key={c.label} className="flex items-start gap-1.5 text-xs">
                        {c.ok ? (
                          <Check size={13} className="text-ok mt-0.5 shrink-0" />
                        ) : (
                          <X size={13} className={`${c.blocking ? 'text-danger' : 'text-warn'} mt-0.5 shrink-0`} />
                        )}
                        <span className={c.ok ? '' : c.blocking ? 'text-danger' : 'text-warn'}>
                          {c.label}
                          {!c.ok && !c.blocking ? ' (warning)' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-3 sm:grid-cols-3 max-w-xl">
                <Field label="Min quantity per order">
                  <Input type="number" min="1" value={draft.min_qty} onChange={(e) => set('min_qty', e.target.value)} />
                </Field>
                <Field label="Max quantity per order">
                  <Input type="number" min="1" value={draft.max_qty} onChange={(e) => set('max_qty', e.target.value)} placeholder="No limit" />
                </Field>
                <Field label="Total usage limit">
                  <Input type="number" min="1" value={draft.usage_limit} onChange={(e) => set('usage_limit', e.target.value)} placeholder="Unlimited" />
                </Field>
                <p className="sm:col-span-3 text-[11px] text-muted">
                  Checked when an order is placed — at the counter and on the customer menu alike.
                </p>
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-bold mb-1.5">Order types</div>
                    {(Object.keys(ORDER_TYPE_LABEL) as OrderType[]).map((t) => (
                      <label key={t} className="flex items-center gap-2 text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={draft.order_types.includes(t)}
                          onChange={(e) =>
                            set('order_types', e.target.checked ? [...draft.order_types, t] : draft.order_types.filter((x) => x !== t))
                          }
                        />
                        {ORDER_TYPE_LABEL[t]}
                      </label>
                    ))}
                  </div>
                  <div>
                    <div className="text-xs font-bold mb-1.5">Sales channels</div>
                    {(Object.keys(CHANNEL_LABEL) as SalesChannel[]).map((c) => (
                      <label key={c} className="flex items-center gap-2 text-xs py-0.5">
                        <input
                          type="checkbox"
                          checked={draft.sales_channels.includes(c)}
                          onChange={(e) =>
                            set('sales_channels', e.target.checked ? [...draft.sales_channels, c] : draft.sales_channels.filter((x) => x !== c))
                          }
                        />
                        {CHANNEL_LABEL[c]}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border border-border p-3 text-xs space-y-1.5">
                  <div className="font-bold">Kitchen availability</div>
                  {deal && availability ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted">Status</span>
                        <span className={availability.available_qty === 0 ? 'text-danger font-bold' : 'text-ok font-bold'}>
                          {availability.available_qty === 0 ? 'UNAVAILABLE' : 'AVAILABLE'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Can make now</span>
                        <span className="font-semibold tabular-nums">
                          {availability.available_qty == null ? 'Not limited' : Math.floor(availability.available_qty)}
                        </span>
                      </div>
                      {availability.bottleneck_name && (
                        <div className="flex justify-between">
                          <span className="text-muted">Bottleneck item</span>
                          <span className="font-semibold">{availability.bottleneck_name}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-muted text-[11px]">Calculated from the menu and inventory once the deal is saved.</p>
                  )}
                  <p className="text-[10px] text-muted pt-1">Automatically calculated from the underlying menu and inventory — never set by hand.</p>
                </div>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-3 max-w-xl">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Start date">
                    <Input type="date" value={draft.start_date} onChange={(e) => set('start_date', e.target.value)} />
                  </Field>
                  <Field label="End date">
                    <Input type="date" value={draft.end_date} onChange={(e) => set('end_date', e.target.value)} />
                  </Field>
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs font-bold mb-1.5">
                    <input type="checkbox" checked={draft.all_days} onChange={(e) => set('all_days', e.target.checked)} />
                    Available every day
                  </label>
                  {!draft.all_days && (
                    <div className="flex flex-wrap gap-1">
                      {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() =>
                            set('active_days', draft.active_days.includes(d) ? draft.active_days.filter((x) => x !== d) : [...draft.active_days, d])
                          }
                          className={`w-11 rounded border py-1 text-[11px] font-semibold ${
                            draft.active_days.includes(d) ? 'bg-primary text-primary-fg border-primary' : 'border-border text-muted'
                          }`}
                        >
                          {DAY_LABEL[d]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From (time)">
                    <Input type="time" value={draft.start_time} onChange={(e) => set('start_time', e.target.value)} />
                  </Field>
                  <Field label="To (time)">
                    <Input type="time" value={draft.end_time} onChange={(e) => set('end_time', e.target.value)} />
                  </Field>
                </div>
                <p className="text-[11px] text-muted">Leave times blank to offer it all day. Times use the restaurant&rsquo;s time zone.</p>
              </div>
            )}

            {step === 6 && (
              <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
                <Field label="Tagline">
                  <Input value={draft.tagline} onChange={(e) => set('tagline', e.target.value)} placeholder="Feed the whole family for less" />
                </Field>
                <Field label="Badge">
                  <Input value={draft.badge} onChange={(e) => set('badge', e.target.value)} placeholder="Family favorite" />
                </Field>
                <label className="flex items-center gap-2 text-xs sm:col-span-2">
                  <input type="checkbox" checked={draft.show_savings} onChange={(e) => set('show_savings', e.target.checked)} />
                  Show &ldquo;Save {money(savings, currency)}&rdquo; and the crossed-out regular price
                </label>
              </div>
            )}

            {step === 7 && (
              <div className="grid gap-4 sm:grid-cols-2 text-xs">
                <dl className="space-y-1.5">
                  {[
                    ['Name', draft.name || '—'],
                    ['Type', TYPE_LABEL[draft.deal_type]],
                    ['Items', `${itemCount}`],
                    ['Regular value', money(regular, currency)],
                    ['Deal price', money(priceCents, currency)],
                    ['Savings', `${money(savings, currency)}${pct != null ? ` (${pct}%)` : ''}`],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted">{k}</dt>
                      <dd className="font-semibold text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
                <dl className="space-y-1.5">
                  {[
                    [
                      'Schedule',
                      validityLabel({ starts_at: startsAtIso, ends_at: endsAtIso, active_days: draft.all_days ? null : draft.active_days }),
                    ],
                    ['Timing', draft.start_time && draft.end_time ? `${timeLabel(draft.start_time)} – ${timeLabel(draft.end_time)}` : 'All day'],
                    ['Order types', draft.order_types.map((t) => ORDER_TYPE_LABEL[t]).join(', ') || '—'],
                    ['Channels', draft.sales_channels.map((c) => CHANNEL_LABEL[c]).join(', ') || '—'],
                    ['Per order', `${draft.min_qty || 1}${draft.max_qty ? `–${draft.max_qty}` : '+'}`],
                    ['Usage limit', draft.usage_limit || 'Unlimited'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-muted">{k}</dt>
                      <dd className="font-semibold text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
                {blocked && (
                  <p className="sm:col-span-2 text-danger">Some required checks fail — see Offer &amp; Pricing → Validation.</p>
                )}
              </div>
            )}

            <div className="mt-4 flex justify-between border-t border-border pt-3">
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>
                Back
              </Button>
              {step < STEPS.length - 1 && <Button onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>Next</Button>}
            </div>
          </Card>
          {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-3 text-xs">{error}</div>}
        </div>

        {/* Right column: live preview + summary */}
        <div className="space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted">Live customer view</div>
          {preview}
          <Card className="p-3">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-2">Deal summary</div>
            <dl className="text-[11px] space-y-1">
              <div className="flex justify-between">
                <dt className="text-muted">Status</dt>
                <dd className="font-semibold">{deal ? STATUS_LABEL[derivedStatus] : 'Draft'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Items</dt>
                <dd className="font-semibold">{itemCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Regular value</dt>
                <dd className="font-semibold tabular-nums">{money(regular, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Deal price</dt>
                <dd className="font-semibold tabular-nums">{money(priceCents, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Savings</dt>
                <dd className="font-semibold tabular-nums text-ok">{money(savings, currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">Schedule</dt>
                <dd className="font-semibold text-right">
                  {validityLabel({ starts_at: startsAtIso, ends_at: endsAtIso, active_days: draft.all_days ? null : draft.active_days })}
                </dd>
              </div>
            </dl>
            <div className="mt-2 flex flex-wrap gap-1">
              {[...draft.order_types.map((t) => ORDER_TYPE_LABEL[t]), ...draft.sales_channels.map((c) => CHANNEL_LABEL[c])].map((c) => (
                <span key={c} className="rounded-full bg-main px-1.5 py-0.5 text-[10px]">
                  <Check size={9} className="inline text-ok -mt-0.5" /> {c}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Action bar */}
      {canSave ? (
        <div className="sticky bottom-3 z-10 flex justify-center">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-body/95 px-3 py-2 shadow-lg backdrop-blur">
            <button onClick={onClose} className="rounded px-3 py-1.5 text-xs font-semibold text-surface/80 hover:text-surface">
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() => save('draft')}
              className="rounded border border-surface/30 px-3 py-1.5 text-xs font-semibold text-surface disabled:opacity-50"
            >
              Save as Draft
            </button>
            <button
              disabled={busy || !startsInFuture}
              title={startsInFuture ? undefined : 'Set a future start date in Schedule to schedule this deal'}
              onClick={() => save('active')}
              className="rounded border border-surface/30 px-3 py-1.5 text-xs font-semibold text-surface disabled:opacity-40"
            >
              Schedule Deal
            </button>
            <button
              disabled={busy || blocked}
              onClick={() => save('active')}
              className="rounded bg-primary px-3 py-1.5 text-xs font-bold text-primary-fg disabled:opacity-50"
            >
              {busy ? 'Saving…' : deal ? 'Save & Publish' : 'Publish Deal'}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted">You can view this deal but not change it.</p>
      )}
    </div>
  );
}
