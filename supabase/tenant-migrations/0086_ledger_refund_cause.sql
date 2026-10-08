-- ============================================================================
-- 0086_ledger_refund_cause.sql — follow-up to 0085
-- refund_payment() changes refunded_cents AND status (captured →
-- partially_refunded/refunded) in one update, so the payment trigger must
-- treat any refunded_cents change as a refund, not a generic adjustment.
-- ============================================================================
create or replace function app.ledger_on_payment() returns trigger
language plpgsql security definer set search_path = public, app as $fn$
begin
  perform app.ledger_sync_payment(coalesce(new.id, old.id),
    case when tg_op = 'UPDATE' and new.refunded_cents is distinct from old.refunded_cents
              and new.status <> 'voided' then 'refund' else lower(tg_op) end);
  return null;
end $fn$;
