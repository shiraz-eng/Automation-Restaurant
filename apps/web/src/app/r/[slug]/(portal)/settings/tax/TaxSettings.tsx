'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Input } from '@/components/ui';

/**
 * Sales tax on/off and rate. place_order() reads this setting itself
 * (app.tax_rate_bps(), tenant-migrations/0078), so the checkout, the QR
 * menu and guest orders all charge the same rate and no device can send
 * its own. Orders keep the rate they were placed with.
 */
export function TaxSettings({
  taxEnabled,
  taxRateBps,
  canEdit,
}: {
  taxEnabled: boolean;
  taxRateBps: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [enabled, setEnabled] = useState(taxEnabled);
  const [rate, setRate] = useState(String(taxRateBps / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    const pct = Number(rate);
    if (enabled && (!rate.trim() || !Number.isFinite(pct) || pct < 0 || pct > 50)) {
      setError('Enter a tax rate between 0 and 50%.');
      return;
    }
    setBusy(true);
    const { error: e } = await supabase
      .from('business_settings')
      .update({ tax_enabled: enabled, ...(enabled ? { tax_rate_bps: Math.round(pct * 100) } : {}) })
      .eq('id', true);
    setBusy(false);
    if (e) {
      setError(e.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const current = taxEnabled ? `${taxRateBps / 100}% is added to every new order.` : 'No tax is added to new orders.';

  return (
    <Card>
      <h2 className="font-bold text-sm mb-1">Tax</h2>
      <p className="text-muted text-[11px] mb-4">
        Added on top of menu prices, after discounts, at the checkout, the QR menu and online orders. Changing it only
        affects new orders — orders already placed keep their tax.
      </p>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{error}</div>}

      <label className="flex items-center gap-2 text-xs font-semibold mb-3">
        <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
        Charge tax
      </label>

      <div className="flex items-end gap-3">
        <Field label="Tax rate (%)">
          <Input
            type="number"
            min="0"
            max="50"
            step="0.01"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="e.g. 16"
            disabled={!canEdit || !enabled}
          />
        </Field>
        {canEdit && (
          <Button disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      {saved && <p className="text-ok text-[11px] mt-2">Saved.</p>}
      <p className="text-muted text-[11px] mt-3">Currently: {current} The name printed on receipts is set in Receipt settings.</p>
    </Card>
  );
}
