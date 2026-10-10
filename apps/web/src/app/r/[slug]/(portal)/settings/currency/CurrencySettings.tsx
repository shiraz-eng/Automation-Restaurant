'use client';

import { useState } from 'react';
import { CURRENCIES, formatMoney } from '@automation-restaurant/shared';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Field, Select } from '@/components/ui';

/**
 * The restaurant's currency (set_currency()). Every screen, receipt, PDF and
 * Excel report, the guest menu and the AI assistant format money in it.
 * It changes how amounts are shown — nothing is converted.
 */
export function CurrencySettings({ currency, canEdit }: { currency: string; canEdit: boolean }) {
  const supabase = usePortalSupabase();
  const [code, setCode] = useState(currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    setBusy(true);
    const { error: e } = await supabase.rpc('set_currency', { p_code: code });
    setBusy(false);
    if (e) {
      setError(e.message === 'unsupported_currency' ? 'That currency is not supported.' : e.message);
      return;
    }
    // A full reload, so every screen (and the cached menu) picks up the new symbol.
    window.location.reload();
  }

  return (
    <Card>
      <h2 className="font-bold text-sm mb-1">Currency</h2>
      <p className="text-muted text-[11px] mb-4">
        Used on every screen, receipt, PDF and Excel report, the customer menu and in AI answers. Changing it changes the
        symbol and formatting only. Amounts are not converted, so pick your real currency before you start trading.
      </p>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs mb-3">{error}</div>}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Currency">
          <Select id="currency-code" value={code} onChange={(e) => setCode(e.target.value)} disabled={!canEdit}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} · {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {canEdit && code !== currency && (
          <Button disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      <p className="text-muted text-[11px] mt-3">
        Example: a price of 1,250.50 shows as <span className="font-mono">{formatMoney(125050, code)}</span>
        {code !== currency && <> (currently {formatMoney(125050, currency)})</>}.
      </p>
    </Card>
  );
}
