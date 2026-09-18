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
export function PoliciesManager({
  slug,
  maxRefundWithoutApprovalCents,
  canEdit,
}: {
  slug: string;
  maxRefundWithoutApprovalCents: number | null;
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

  return (
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
  );
}
