'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { formatCents } from '@/lib/format';

/**
 * The refund-approval threshold (spec: "Action + amount + role + policy
 * = authorization") — the one place this policy is set. Enforcement
 * itself lives in refund_payment() (schema.sql/tenant-migrations/0041),
 * not here: this page can only ever propose a number, never bypass the
 * database check, so a direct RPC call is held to the same rule as the
 * Checkout page's own refund button.
 */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ACCEPTED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

export function PoliciesManager({
  slug,
  maxRefundWithoutApprovalCents,
  receiptLogoUrl,
  receiptFooterText,
  receiptTemplateHtml,
  canEdit,
}: {
  slug: string;
  maxRefundWithoutApprovalCents: number | null;
  receiptLogoUrl: string | null;
  receiptFooterText: string | null;
  receiptTemplateHtml: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [value, setValue] = useState(
    maxRefundWithoutApprovalCents != null ? (maxRefundWithoutApprovalCents / 100).toFixed(2) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [footerText, setFooterText] = useState(receiptFooterText ?? '');
  const [templateHtml, setTemplateHtml] = useState(receiptTemplateHtml ?? '');
  const [showTemplate, setShowTemplate] = useState(!!receiptTemplateHtml);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [receiptSaved, setReceiptSaved] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  async function save(newCents: number | null) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: e } = await supabase
      .from('business_settings')
      .update({ max_refund_without_approval_cents: newCents })
      .eq('id', true);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  async function uploadLogo(file: File) {
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setReceiptError('Logo must be JPG, PNG, WebP, or SVG.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setReceiptError('Logo must be under 2 MB.');
      return;
    }
    setUploadingLogo(true);
    setReceiptError(null);
    const ext = file.name.split('.').pop() ?? 'png';
    const path = `logo-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('branding').upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) {
      setUploadingLogo(false);
      setReceiptError(upErr.message);
      return;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from('branding').getPublicUrl(path);
    const { error: dbErr } = await supabase.from('business_settings').update({ receipt_logo_url: publicUrl }).eq('id', true);
    setUploadingLogo(false);
    if (dbErr) {
      setReceiptError(dbErr.message);
      return;
    }
    router.refresh();
  }

  async function removeLogo() {
    setReceiptError(null);
    const { error: e } = await supabase.from('business_settings').update({ receipt_logo_url: null }).eq('id', true);
    if (e) {
      setReceiptError(e.message);
      return;
    }
    router.refresh();
  }

  async function saveReceiptText() {
    setBusy(true);
    setReceiptError(null);
    setReceiptSaved(false);
    const { error: e } = await supabase
      .from('business_settings')
      .update({
        receipt_footer_text: footerText.trim() || null,
        receipt_template_html: showTemplate ? templateHtml.trim() || null : null,
      })
      .eq('id', true);
    setBusy(false);
    if (e) {
      setReceiptError(e.message);
      return;
    }
    setReceiptSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-6">
    <Card>
      <h2 className="font-bold text-sm mb-1">Refund approval threshold</h2>
      <p className="text-muted text-[11px] mb-4">
        Refunds at or under this amount can be processed by anyone with the Refund permission. Anything over it
        additionally requires the Approve Refund permission (owner/manager have it by default) — enforced by
        refund_payment() itself, so this can never be worked around from the Checkout screen.
      </p>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{error}</div>}

      <div className="flex items-end gap-3">
        <Field label="Maximum without approval">
          <Input
            type="number"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="No limit"
            disabled={!canEdit}
          />
        </Field>
        {canEdit && (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                const cents = value.trim() ? Math.round(parseFloat(value) * 100) : null;
                if (cents != null && (!Number.isFinite(cents) || cents <= 0)) {
                  setError('Enter a positive amount, or leave it blank for no limit.');
                  return;
                }
                save(cents);
              }}
            >
              Save
            </Button>
            {maxRefundWithoutApprovalCents != null && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setValue('');
                  save(null);
                }}
              >
                Remove limit
              </Button>
            )}
          </>
        )}
      </div>
      {saved && <p className="text-ok text-[11px] mt-2">Saved.</p>}
      <p className="text-muted text-[11px] mt-3">
        {maxRefundWithoutApprovalCents != null
          ? `Currently: refunds over ${formatCents(maxRefundWithoutApprovalCents)} need approval.`
          : 'Currently: no limit — any refund amount is allowed with just the Refund permission.'}
      </p>
    </Card>

    <Card>
      <h2 className="font-bold text-sm mb-1">Receipt</h2>
      <p className="text-muted text-[11px] mb-4">
        Shown on every printed/PDF receipt from Checkout. A logo and footer line cover most
        needs — the custom HTML template below is for a fully different layout, if needed.
      </p>

      {receiptError && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{receiptError}</div>}

      <div className="flex items-center gap-3 mb-4">
        {receiptLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={receiptLogoUrl} alt="Receipt logo" className="h-14 max-w-[140px] object-contain border border-border rounded bg-surface p-1" />
        ) : (
          <div className="h-14 w-28 rounded border border-dashed border-border grid place-items-center text-muted text-[10px]">
            No logo
          </div>
        )}
        {canEdit && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-primary cursor-pointer">
              {uploadingLogo ? 'Uploading…' : receiptLogoUrl ? 'Replace logo' : 'Upload logo'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/svg+xml"
                className="hidden"
                disabled={uploadingLogo}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) uploadLogo(file);
                }}
              />
            </label>
            {receiptLogoUrl && (
              <button onClick={removeLogo} className="text-xs font-semibold text-danger text-left">
                Remove
              </button>
            )}
          </div>
        )}
      </div>

      <Field label="Footer text">
        <Input
          value={footerText}
          onChange={(e) => setFooterText(e.target.value)}
          placeholder="Thank you for dining with us!"
          disabled={!canEdit}
        />
      </Field>

      <button
        onClick={() => setShowTemplate((s) => !s)}
        className="text-primary text-xs font-semibold underline mt-3"
      >
        {showTemplate ? 'Hide custom HTML template' : 'Use a custom HTML template instead'}
      </button>

      {showTemplate && (
        <div className="mt-2 space-y-1.5">
          <p className="text-muted text-[11px]">
            Plain HTML. Available placeholders: <code>{'{{restaurant_name}}'}</code>{' '}
            <code>{'{{logo_html}}'}</code> <code>{'{{order_number}}'}</code> <code>{'{{table}}'}</code>{' '}
            <code>{'{{customer}}'}</code> <code>{'{{date}}'}</code> <code>{'{{lines_html}}'}</code>{' '}
            <code>{'{{subtotal}}'}</code> <code>{'{{discount_row}}'}</code> <code>{'{{tax}}'}</code>{' '}
            <code>{'{{refunded_row}}'}</code> <code>{'{{total}}'}</code> <code>{'{{paid_via}}'}</code>{' '}
            <code>{'{{footer}}'}</code>. Never executed as code — plain text substitution only.
          </p>
          <textarea
            value={templateHtml}
            onChange={(e) => setTemplateHtml(e.target.value)}
            disabled={!canEdit}
            rows={10}
            className="w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs font-mono outline-none focus:border-primary"
            placeholder="<h1>{{restaurant_name}}</h1>..."
          />
        </div>
      )}

      {canEdit && (
        <Button className="mt-3" disabled={busy} onClick={saveReceiptText}>
          {busy ? 'Saving…' : 'Save receipt settings'}
        </Button>
      )}
      {receiptSaved && <p className="text-ok text-[11px] mt-2">Saved.</p>}
    </Card>
    </div>
  );
}
