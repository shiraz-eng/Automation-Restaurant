'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input, Select } from '@/components/ui';
import {
  ALL_SECTIONS,
  DEFAULT_RECEIPT_CONFIG,
  RECEIPT_VARIABLES,
  buildReceiptBlocks,
  type Align,
  type CustomTextBlock,
  type DividerStyle,
  type ReceiptBlock,
  type ReceiptConfig,
  type ReceiptContext,
  type ReceiptSectionId,
} from '@/lib/receiptTemplate';

const ALIGNS: Align[] = ['left', 'center', 'right'];
const DIVIDERS: { id: DividerStyle; label: string }[] = [
  { id: 'dashed', label: '- - - - -' },
  { id: 'solid', label: '─────' },
  { id: 'double', label: '═════' },
  { id: 'space', label: '(blank line)' },
];

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** "showOrderNumber" -> "Order number" for a sub-field checkbox label. */
function fieldLabel(key: string): string {
  const s = key.replace(/^show/, '');
  return s.replace(/([A-Z])/g, ' $1').trim().replace(/^./, (c) => c.toUpperCase());
}

/** Deep-merges a partial config over the default so a restaurant that
 *  configured this before a new field/section existed doesn't crash on
 *  missing keys — every new option ships with a safe default. */
function normalizeConfig(raw: Partial<ReceiptConfig> | null | undefined): ReceiptConfig {
  if (!raw) return structuredClone(DEFAULT_RECEIPT_CONFIG);
  return {
    width: raw.width ?? DEFAULT_RECEIPT_CONFIG.width,
    dividerStyle: raw.dividerStyle ?? DEFAULT_RECEIPT_CONFIG.dividerStyle,
    sectionOrder: raw.sectionOrder?.length ? raw.sectionOrder : DEFAULT_RECEIPT_CONFIG.sectionOrder,
    header: { ...DEFAULT_RECEIPT_CONFIG.header, ...raw.header },
    restaurantInfo: { ...DEFAULT_RECEIPT_CONFIG.restaurantInfo, ...raw.restaurantInfo },
    orderInfo: { ...DEFAULT_RECEIPT_CONFIG.orderInfo, ...raw.orderInfo },
    items: { ...DEFAULT_RECEIPT_CONFIG.items, ...raw.items },
    discount: { ...DEFAULT_RECEIPT_CONFIG.discount, ...raw.discount },
    totals: { ...DEFAULT_RECEIPT_CONFIG.totals, ...raw.totals },
    payment: { ...DEFAULT_RECEIPT_CONFIG.payment, ...raw.payment },
    orderStatus: { ...DEFAULT_RECEIPT_CONFIG.orderStatus, ...raw.orderStatus },
    customText: raw.customText ?? DEFAULT_RECEIPT_CONFIG.customText,
  };
}

export function ReceiptManager({
  slug: _slug,
  canEdit,
  initialConfig,
  restaurantName,
  logoUrl,
  primaryColor,
  restaurant,
  previewOrder,
  legacyTemplateHtml,
}: {
  slug: string;
  canEdit: boolean;
  initialConfig: ReceiptConfig | null;
  restaurantName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  restaurant: { address: string | null; phone: string | null; email: string | null; website: string | null; taxId: string | null };
  previewOrder: ReceiptContext | null;
  legacyTemplateHtml: string | null;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [config, setConfig] = useState<ReceiptConfig>(() => normalizeConfig(initialConfig));
  const [contact, setContact] = useState(restaurant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [clearingLegacy, setClearingLegacy] = useState(false);

  async function clearLegacyTemplate() {
    setClearingLegacy(true);
    setError(null);
    const { error: e } = await supabase.from('business_settings').update({ receipt_template_html: null }).eq('id', true);
    setClearingLegacy(false);
    if (e) {
      setError(e.message);
      return;
    }
    router.refresh();
  }

  const enabled = config.sectionOrder;
  const disabled = ALL_SECTIONS.filter((s) => !enabled.includes(s.id)).map((s) => s.id);

  function toggleSection(id: ReceiptSectionId, on: boolean) {
    setConfig((c) => ({
      ...c,
      sectionOrder: on ? [...c.sectionOrder, id] : c.sectionOrder.filter((s) => s !== id),
    }));
  }
  function moveSection(id: ReceiptSectionId, dir: -1 | 1) {
    setConfig((c) => {
      const i = c.sectionOrder.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.sectionOrder.length) return c;
      const next = [...c.sectionOrder];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...c, sectionOrder: next };
    });
  }
  function patch<K extends keyof ReceiptConfig>(key: K, value: Partial<ReceiptConfig[K]>) {
    setConfig((c) => ({ ...c, [key]: { ...(c[key] as object), ...value } }));
  }

  function addText() {
    setConfig((c) => ({ ...c, customText: [...c.customText, { id: uid(), text: '', align: 'center', bold: false }] }));
  }
  function updateText(id: string, patchVal: Partial<CustomTextBlock>) {
    setConfig((c) => ({ ...c, customText: c.customText.map((t) => (t.id === id ? { ...t, ...patchVal } : t)) }));
  }
  function removeText(id: string) {
    setConfig((c) => ({ ...c, customText: c.customText.filter((t) => t.id !== id) }));
  }
  function moveText(id: string, dir: -1 | 1) {
    setConfig((c) => {
      const i = c.customText.findIndex((t) => t.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.customText.length) return c;
      const next = [...c.customText];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...c, customText: next };
    });
  }

  const previewCtx: ReceiptContext = useMemo(
    () =>
      previewOrder ?? {
        restaurantName,
        logoUrl,
        primaryColor,
        address: contact.address,
        phone: contact.phone,
        email: contact.email,
        website: contact.website,
        taxId: contact.taxId,
        orderNumber: 3007,
        tableLabel: 'Table 1',
        customerName: 'Walk-in',
        orderType: 'dine in',
        createdAt: new Date().toISOString(),
        paidAt: new Date().toISOString(),
        orderStatus: 'paid',
        lines: [
          { qty: 2, name: 'Chicken Burger', variantName: 'Large', modifiers: [{ name: 'Extra Cheese', price_cents: 100 }], notes: null, unitPriceCents: 850, lineTotalCents: 1700 },
          { qty: 1, name: 'Fries', variantName: 'Regular', modifiers: [], notes: null, unitPriceCents: 425, lineTotalCents: 425 },
          { qty: 1, name: 'Cola', variantName: 'Medium', modifiers: [], notes: null, unitPriceCents: 325, lineTotalCents: 325 },
        ],
        subtotalCents: 2450,
        discountCents: 0,
        taxCents: 319,
        taxRateBps: 1500,
        totalCents: 2769,
        refundedCents: 0,
        paymentMethod: 'cash',
        paymentReference: null,
        amountPaidCents: 4000,
        changeCents: 1231,
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewOrder, restaurantName, logoUrl, primaryColor, contact],
  );
  // Override the sample's own restaurant/contact fields with whatever is
  // currently being edited (so ticking "show phone" reflects immediately,
  // even when the preview is seeded from a real order).
  const liveCtx: ReceiptContext = {
    ...previewCtx,
    restaurantName,
    logoUrl,
    primaryColor,
    address: contact.address,
    phone: contact.phone,
    email: contact.email,
    website: contact.website,
    taxId: contact.taxId,
  };
  const blocks = useMemo(() => buildReceiptBlocks(config, liveCtx), [config, liveCtx]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: e } = await supabase
      .from('business_settings')
      .update({
        receipt_config: config,
        address: contact.address?.trim() || null,
        phone: contact.phone?.trim() || null,
        contact_email: contact.email?.trim() || null,
        website: contact.website?.trim() || null,
        tax_registration_number: contact.taxId?.trim() || null,
      })
      .eq('id', true);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const sectionLabel = (id: ReceiptSectionId) => ALL_SECTIONS.find((s) => s.id === id)?.label ?? id;

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <h2 className="font-bold text-sm">Restaurant contact details</h2>
        <p className="text-muted text-[11px]">Used by the receipt&rsquo;s &ldquo;Restaurant information&rdquo; section below.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Address">
            <Input value={contact.address ?? ''} disabled={!canEdit} onChange={(e) => setContact((c) => ({ ...c, address: e.target.value }))} placeholder="123 Main Street, Karachi" />
          </Field>
          <Field label="Phone">
            <Input value={contact.phone ?? ''} disabled={!canEdit} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} placeholder="021-XXXXXXX" />
          </Field>
          <Field label="Email">
            <Input value={contact.email ?? ''} disabled={!canEdit} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} />
          </Field>
          <Field label="Website">
            <Input value={contact.website ?? ''} disabled={!canEdit} onChange={(e) => setContact((c) => ({ ...c, website: e.target.value }))} />
          </Field>
          <Field label="Tax registration number">
            <Input value={contact.taxId ?? ''} disabled={!canEdit} onChange={(e) => setContact((c) => ({ ...c, taxId: e.target.value }))} />
          </Field>
        </div>
      </Card>

      {legacyTemplateHtml && (
        <Card className="border-warn/40 bg-warn/5">
          <h2 className="font-bold text-sm mb-1">Custom HTML template active</h2>
          <p className="text-muted text-[11px] mb-3">
            An older custom HTML receipt template is set (from Policies). It still takes priority when printing —
            the layout below is already used for the PDF download. Clear it to let this layout apply to printing too.
          </p>
          {canEdit && (
            <Button variant="ghost" disabled={clearingLegacy} onClick={clearLegacyTemplate}>
              {clearingLegacy ? 'Clearing…' : 'Clear custom HTML template'}
            </Button>
          )}
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="font-bold text-sm">Receipt style</h2>
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <span className="text-[11px] font-semibold text-muted block mb-1">Thermal width</span>
            <div className="flex gap-1.5">
              {(['58mm', '80mm'] as const).map((w) => (
                <Button key={w} variant={config.width === w ? 'primary' : 'ghost'} disabled={!canEdit} onClick={() => setConfig((c) => ({ ...c, width: w }))}>
                  {w}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[11px] font-semibold text-muted block mb-1">Divider style</span>
            <Select value={config.dividerStyle} disabled={!canEdit} onChange={(e) => setConfig((c) => ({ ...c, dividerStyle: e.target.value as DividerStyle }))}>
              {DIVIDERS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold text-sm mb-1">Sections</h2>
        <p className="text-muted text-[11px] mb-2">Only checked sections appear, in this order. Use the arrows to reorder.</p>

        <div className="space-y-2">
          {enabled.map((id, i) => (
            <div key={id} className="rounded border border-border p-2.5">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked disabled={!canEdit} onChange={() => toggleSection(id, false)} />
                <span className="text-xs font-semibold flex-1">{sectionLabel(id)}</span>
                <button type="button" disabled={!canEdit || i === 0} onClick={() => moveSection(id, -1)} className="text-muted disabled:opacity-30 px-1">
                  ↑
                </button>
                <button type="button" disabled={!canEdit || i === enabled.length - 1} onClick={() => moveSection(id, 1)} className="text-muted disabled:opacity-30 px-1">
                  ↓
                </button>
              </div>

              {id === 'header' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-2 text-[11px]">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.header.showLogo} disabled={!canEdit} onChange={(e) => patch('header', { showLogo: e.target.checked })} />
                    Show logo
                  </label>
                  <Select value={config.header.logoSize} disabled={!canEdit} onChange={(e) => patch('header', { logoSize: e.target.value as 'sm' | 'md' | 'lg' })}>
                    <option value="sm">Logo: small</option>
                    <option value="md">Logo: medium</option>
                    <option value="lg">Logo: large</option>
                  </Select>
                  <Select value={config.header.logoAlign} disabled={!canEdit} onChange={(e) => patch('header', { logoAlign: e.target.value as Align })}>
                    {ALIGNS.map((a) => (
                      <option key={a} value={a}>
                        Logo align: {a}
                      </option>
                    ))}
                  </Select>
                  <Select value={config.header.nameAlign} disabled={!canEdit} onChange={(e) => patch('header', { nameAlign: e.target.value as Align })}>
                    {ALIGNS.map((a) => (
                      <option key={a} value={a}>
                        Name align: {a}
                      </option>
                    ))}
                  </Select>
                  <Input className="col-span-2" placeholder="Tagline" value={config.header.tagline} disabled={!canEdit} onChange={(e) => patch('header', { tagline: e.target.value })} />
                  <Input className="col-span-2" placeholder="Welcome message" value={config.header.welcomeMessage} disabled={!canEdit} onChange={(e) => patch('header', { welcomeMessage: e.target.value })} />
                </div>
              )}

              {id === 'restaurant_info' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px]">
                  {(['showAddress', 'showPhone', 'showEmail', 'showWebsite', 'showTaxId'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={config.restaurantInfo[k]} disabled={!canEdit} onChange={(e) => patch('restaurantInfo', { [k]: e.target.checked })} />
                      {fieldLabel(k)}
                    </label>
                  ))}
                </div>
              )}

              {id === 'order_info' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px]">
                  {(['showOrderNumber', 'showDate', 'showTime', 'showTable', 'showCustomer', 'showOrderType'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={config.orderInfo[k]} disabled={!canEdit} onChange={(e) => patch('orderInfo', { [k]: e.target.checked })} />
                      {fieldLabel(k)}
                    </label>
                  ))}
                </div>
              )}

              {id === 'items' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px]">
                  {(['showVariant', 'showModifiers', 'showNotes'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={config.items[k]} disabled={!canEdit} onChange={(e) => patch('items', { [k]: e.target.checked })} />
                      {fieldLabel(k)}
                    </label>
                  ))}
                </div>
              )}

              {id === 'discount' && (
                <div className="mt-2 pl-6 flex items-center gap-3 text-[11px]">
                  <Input value={config.discount.label} disabled={!canEdit} onChange={(e) => patch('discount', { label: e.target.value })} placeholder="Label (e.g. Discount)" />
                </div>
              )}

              {id === 'totals' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px] items-center">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.totals.showSubtotal} disabled={!canEdit} onChange={(e) => patch('totals', { showSubtotal: e.target.checked })} />
                    Subtotal
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.totals.showTax} disabled={!canEdit} onChange={(e) => patch('totals', { showTax: e.target.checked })} />
                    Tax
                  </label>
                  <Input value={config.totals.taxLabel} disabled={!canEdit} onChange={(e) => patch('totals', { taxLabel: e.target.value })} placeholder="Tax label (e.g. VAT)" />
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.totals.showTotal} disabled={!canEdit} onChange={(e) => patch('totals', { showTotal: e.target.checked })} />
                    Total
                  </label>
                </div>
              )}

              {id === 'payment' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px]">
                  {(['showMethod', 'showAmountPaid', 'showChange', 'showReference'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={config.payment[k]} disabled={!canEdit} onChange={(e) => patch('payment', { [k]: e.target.checked })} />
                      {fieldLabel(k)}
                    </label>
                  ))}
                </div>
              )}

              {id === 'order_status' && (
                <div className="mt-2 pl-6 grid grid-cols-2 gap-1.5 text-[11px]">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.orderStatus.showStatus} disabled={!canEdit} onChange={(e) => patch('orderStatus', { showStatus: e.target.checked })} />
                    Order status
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={config.orderStatus.showClosedAt} disabled={!canEdit} onChange={(e) => patch('orderStatus', { showClosedAt: e.target.checked })} />
                    Closed timestamp
                  </label>
                </div>
              )}

              {id === 'custom_text' && (
                <div className="mt-2 pl-6 space-y-2">
                  {config.customText.map((t, i) => (
                    <div key={t.id} className="rounded border border-border/60 p-2 space-y-1.5">
                      <textarea
                        value={t.text}
                        disabled={!canEdit}
                        onChange={(e) => updateText(t.id, { text: e.target.value })}
                        rows={2}
                        className="w-full rounded border border-border bg-surface px-2 py-1 text-[11px] outline-none focus:border-primary"
                        placeholder="Thank you for visiting!"
                      />
                      <div className="flex items-center gap-2">
                        <Select value={t.align} disabled={!canEdit} onChange={(e) => updateText(t.id, { align: e.target.value as Align })} className="text-[11px]">
                          {ALIGNS.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </Select>
                        <label className="flex items-center gap-1 text-[11px]">
                          <input type="checkbox" checked={t.bold} disabled={!canEdit} onChange={(e) => updateText(t.id, { bold: e.target.checked })} />
                          Bold
                        </label>
                        <button type="button" disabled={!canEdit || i === 0} onClick={() => moveText(t.id, -1)} className="text-muted disabled:opacity-30 px-1 text-xs">
                          ↑
                        </button>
                        <button type="button" disabled={!canEdit || i === config.customText.length - 1} onClick={() => moveText(t.id, 1)} className="text-muted disabled:opacity-30 px-1 text-xs">
                          ↓
                        </button>
                        <button type="button" disabled={!canEdit} onClick={() => removeText(t.id)} className="text-danger text-[11px] font-semibold ml-auto">
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                  {canEdit && (
                    <button type="button" onClick={addText} className="text-primary text-[11px] font-semibold">
                      + Add text block
                    </button>
                  )}
                  <p className="text-muted text-[10px]">
                    Variables: {RECEIPT_VARIABLES.map((v) => `{${v}}`).join(' ')}
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {disabled.length > 0 && (
          <div className="pt-2 border-t border-border">
            <p className="text-muted text-[11px] font-semibold mb-1.5">Not shown</p>
            <div className="flex flex-wrap gap-1.5">
              {disabled.map((id) => (
                <button
                  key={id}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => toggleSection(id, true)}
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] hover:border-primary hover:text-primary"
                >
                  + {sectionLabel(id)}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-1">Preview</h2>
        <p className="text-muted text-[11px] mb-3">
          {previewOrder ? 'Using this restaurant’s most recent order.' : 'No orders yet — showing sample data.'}
        </p>
        <div className="rounded-lg border border-border bg-surface p-3 flex justify-center">
          <ReceiptPreview blocks={blocks} width={config.width} />
        </div>
      </Card>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save receipt template'}
          </Button>
          {saved && <p className="text-ok text-[11px]">Saved — every new receipt now uses this template.</p>}
        </div>
      )}
    </div>
  );
}

/** Walks the SAME ReceiptBlock list the PDF and print HTML renderers
 *  walk — the preview is never a separately-maintained mock layout. */
function ReceiptPreview({ blocks, width }: { blocks: ReceiptBlock[]; width: '58mm' | '80mm' }) {
  return (
    <div
      className="bg-white text-[#111] font-mono text-[11px] p-3 shadow-sm"
      style={{ width: width === '58mm' ? 200 : 280 }}
    >
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'logo':
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={b.url}
                alt=""
                className="object-contain"
                style={{
                  height: b.size === 'sm' ? 28 : b.size === 'lg' ? 56 : 40,
                  margin: b.align === 'center' ? '0 auto 6px' : b.align === 'right' ? '0 0 6px auto' : '0 0 6px 0',
                  display: 'block',
                }}
              />
            );
          case 'text':
            return (
              <div
                key={i}
                className={`${b.bold ? 'font-bold' : ''} ${b.size === 'lg' ? 'text-[13px]' : b.size === 'sm' ? 'text-[10px]' : ''} ${b.muted ? 'text-gray-500' : ''}`}
                style={{ textAlign: b.align }}
              >
                {b.text}
              </div>
            );
          case 'divider':
            return b.style === 'space' ? (
              <div key={i} className="h-2" />
            ) : (
              <hr
                key={i}
                className="my-1.5"
                style={{
                  border: 'none',
                  borderTop: b.style === 'dashed' ? '1px dashed #999' : b.style === 'double' ? '3px double #333' : '1px solid #333',
                }}
              />
            );
          case 'row':
            return (
              <div key={i} className={`flex justify-between gap-2 py-0.5 ${b.bold ? 'font-bold' : ''}`}>
                <span>{b.label}</span>
                <span>{b.value}</span>
              </div>
            );
          case 'item':
            return (
              <div key={i}>
                <div className="flex justify-between gap-2">
                  <span>
                    {b.qty}&times; {b.name}
                  </span>
                  <span>{b.total}</span>
                </div>
                {b.sub.map((s, j) => (
                  <div key={j} className="pl-3 text-[10px] text-gray-600">
                    {s}
                  </div>
                ))}
              </div>
            );
          case 'space':
            return <div key={i} className="h-2" />;
        }
      })}
    </div>
  );
}
