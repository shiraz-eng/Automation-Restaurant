'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { useTheme } from '@/components/ThemeProvider';
import { Button, Card, Field, Input } from '@/components/ui';
import { PRESETS, channelsToHex, hexToChannels, type Appearance, type ThemeTokens } from '@/lib/theme';

const APPEARANCES: Appearance[] = ['light', 'dark', 'system'];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ACCEPTED_LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];

// Fallback hex shown in a color picker before the restaurant has ever
// customized that field — matches globals.css's own light-theme default,
// so the picker starts where the page already visually is.
const NEUTRAL_DEFAULTS: Record<string, string> = {
  'bg-main': '#f8fafc',
  'bg-surface': '#ffffff',
  border: '#e2e8f0',
  'text-body': '#0f172a',
  'text-muted': '#64748b',
};

export function BrandKitManager({
  slug,
  logoUrl,
  receiptFooterText,
  receiptTemplateHtml,
  canEdit,
}: {
  slug: string;
  logoUrl: string | null;
  receiptFooterText: string | null;
  receiptTemplateHtml: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const { theme, setPreset, setPrimary, setRadius, setAppearance, setToken } = useTheme();

  const [currentLogoUrl, setCurrentLogoUrl] = useState(logoUrl);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  const [footerText, setFooterText] = useState(receiptFooterText ?? '');
  const [templateHtml, setTemplateHtml] = useState(receiptTemplateHtml ?? '');
  const [showTemplate, setShowTemplate] = useState(!!receiptTemplateHtml);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function uploadLogo(file: File) {
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setLogoError('Logo must be JPG, PNG, WebP, or SVG.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('Logo must be under 2 MB.');
      return;
    }
    setUploadingLogo(true);
    setLogoError(null);
    const ext = file.name.split('.').pop() ?? 'png';
    const path = `logo-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('branding').upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) {
      setUploadingLogo(false);
      setLogoError(upErr.message);
      return;
    }
    const {
      data: { publicUrl },
    } = supabase.storage.from('branding').getPublicUrl(path);
    const { error: dbErr } = await supabase.from('business_settings').update({ brand_logo_url: publicUrl }).eq('id', true);
    setUploadingLogo(false);
    if (dbErr) {
      setLogoError(dbErr.message);
      return;
    }
    setCurrentLogoUrl(publicUrl);
    router.refresh();
  }

  async function removeLogo() {
    setLogoError(null);
    const { error: e } = await supabase.from('business_settings').update({ brand_logo_url: null }).eq('id', true);
    if (e) {
      setLogoError(e.message);
      return;
    }
    setCurrentLogoUrl(null);
    router.refresh();
  }

  function colorField(key: keyof ThemeTokens, label: string, resettable = false) {
    const raw = theme.tokens[key] as string | undefined;
    const hex = raw ? channelsToHex(raw) : (NEUTRAL_DEFAULTS[key as string] ?? '#ffffff');
    return (
      <label className="flex items-center justify-between text-xs" key={key}>
        <span className="font-semibold">{label}</span>
        <span className="flex items-center gap-2">
          <input
            type="color"
            value={hex}
            disabled={!canEdit}
            onChange={(e) => setToken(key, hexToChannels(e.target.value))}
            className="h-8 w-14 rounded border border-border bg-surface"
          />
          {resettable && raw && canEdit && (
            <button type="button" onClick={() => setToken(key, '')} className="text-primary text-[11px] font-semibold">
              Reset
            </button>
          )}
        </span>
      </label>
    );
  }

  async function saveAll() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: e } = await supabase
      .from('business_settings')
      .update({
        brand_primary: theme.tokens.primary,
        brand_primary_fg: theme.tokens['primary-fg'],
        brand_bg_main: theme.tokens['bg-main'] || null,
        brand_bg_surface: theme.tokens['bg-surface'] || null,
        brand_border: theme.tokens.border || null,
        brand_text_body: theme.tokens['text-body'] || null,
        brand_text_muted: theme.tokens['text-muted'] || null,
        brand_radius: theme.tokens.radius,
        brand_appearance: theme.appearance,
        receipt_footer_text: footerText.trim() || null,
        receipt_template_html: showTemplate ? templateHtml.trim() || null : null,
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

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="font-bold text-sm mb-1">Logo</h2>
        <p className="text-muted text-[11px] mb-4">
          Used in the portal sidebar, printed receipts, invoices, and PDF reports.
        </p>
        {logoError && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{logoError}</div>}
        <div className="flex items-center gap-3">
          {currentLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={currentLogoUrl} alt="Logo" className="h-14 max-w-[140px] object-contain border border-border rounded bg-surface p-1" />
          ) : (
            <div className="h-14 w-28 rounded border border-dashed border-border grid place-items-center text-muted text-[10px]">
              No logo
            </div>
          )}
          {canEdit && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-primary cursor-pointer">
                {uploadingLogo ? 'Uploading…' : currentLogoUrl ? 'Replace logo' : 'Upload logo'}
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
              {currentLogoUrl && (
                <button onClick={removeLogo} className="text-xs font-semibold text-danger text-left">
                  Remove
                </button>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">Preset</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {Object.entries(PRESETS).map(([name, tokens]) => (
            <button
              key={name}
              disabled={!canEdit}
              onClick={() => setPreset(name)}
              className={`rounded-lg border p-3 text-left ${
                theme.preset === name ? 'border-primary' : 'border-border'
              }`}
            >
              <span className="block w-full h-8 rounded mb-2" style={{ background: `rgb(${tokens.primary})` }} />
              <span className="text-[11px] font-semibold">{name}</span>
            </button>
          ))}
          {theme.preset === 'Custom' && (
            <div className="rounded-lg border border-primary p-3">
              <span className="block w-full h-8 rounded mb-2" style={{ background: `rgb(${theme.tokens.primary})` }} />
              <span className="text-[11px] font-semibold">Custom</span>
            </div>
          )}
        </div>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-bold text-sm">Brand colors</h2>

        <label className="flex items-center justify-between text-xs">
          <span className="font-semibold">Primary</span>
          <input
            type="color"
            value={channelsToHex(theme.tokens.primary)}
            disabled={!canEdit}
            onChange={(e) => setPrimary(hexToChannels(e.target.value))}
            className="h-8 w-14 rounded border border-border bg-surface"
          />
        </label>
        {colorField('primary-fg', 'Text on primary')}
        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-muted text-[11px]">
            Optional — leave as default to keep automatic light/dark switching for these.
          </p>
          {colorField('bg-main', 'Page background', true)}
          {colorField('bg-surface', 'Card / surface', true)}
          {colorField('border', 'Border', true)}
          {colorField('text-body', 'Body text', true)}
          {colorField('text-muted', 'Muted text', true)}
        </div>

        <label className="flex items-center justify-between text-xs">
          <span className="font-semibold">Corner radius — {theme.tokens.radius}</span>
          <input
            type="range"
            min={0}
            max={24}
            disabled={!canEdit}
            value={parseInt(theme.tokens.radius, 10) || 0}
            onChange={(e) => setRadius(`${e.target.value}px`)}
            className="w-48 accent-primary"
          />
        </label>

        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold">Appearance</span>
          <div className="flex gap-1.5">
            {APPEARANCES.map((a) => (
              <Button
                key={a}
                variant={theme.appearance === a ? 'primary' : 'ghost'}
                disabled={!canEdit}
                onClick={() => setAppearance(a)}
              >
                {a}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-1">Receipt</h2>
        <p className="text-muted text-[11px] mb-4">
          Shown on every printed/PDF receipt from Checkout, in addition to the logo above. The
          custom HTML template is for a fully different layout, if needed.
        </p>
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
      </Card>

      <Card>
        <h2 className="font-bold text-sm mb-3">Preview</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary button</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <span className="rounded border border-border bg-main px-3 py-1.5 text-xs">
            Surface / border sample
          </span>
          <span className="rounded-lg bg-primary text-primary-fg px-3 py-1.5 text-xs font-semibold">
            Radius {theme.tokens.radius}
          </span>
        </div>
      </Card>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={saveAll}>
            {busy ? 'Saving…' : 'Save Brand Kit'}
          </Button>
          {saved && <p className="text-ok text-[11px]">Saved — now live for every user and guest.</p>}
        </div>
      )}
    </div>
  );
}
