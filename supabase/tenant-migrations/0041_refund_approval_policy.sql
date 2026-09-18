-- 0041: Configurable refund approval policy ("Action + amount + role +
-- policy = authorization") + the attention-items domain-isolation fix
-- (apps/api/src/lib/aiTools.ts — no schema change needed for that half,
-- it's a server-side query change only). Idempotent: safe to re-run.
--
-- Also fixes get_attention_items/get_daily_brief, which previously
-- returned supplier payables and recipe/COGS cost-change data to ANY
-- caller holding just orders.view (held by nearly every role) — that fix
-- lives entirely in application code, nothing here to migrate for it.

alter table public.business_settings
  add column if not exists max_refund_without_approval_cents int;

insert into public.permission_catalog (key, grp, label) values
  ('payments.approve_refund','Payments','Approve a refund above the configured threshold')
on conflict (key) do update set grp = excluded.grp, label = excluded.label;

update public.roles
set permissions = (
  select array(select distinct unnest(permissions || array['payments.approve_refund']))
)
where key = 'manager'
  and not (permissions @> array['payments.approve_refund']);

create or replace function public.refund_payment(
  p_payment_id uuid, p_amount_cents int, p_reason text, p_method text default null
) returns public.refunds
language plpgsql security definer set search_path = public, app as $fn$
declare v_pay public.payments; v_ref public.refunds; v_remaining int; v_threshold int;
begin
  if not app.has_perm('payments.refund') then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'payment_not_found' using errcode = 'no_data_found'; end if;
  v_remaining := v_pay.amount_cents - v_pay.refunded_cents;
  if coalesce(p_amount_cents, 0) <= 0 or p_amount_cents > v_remaining then
    raise exception 'bad_refund_amount: max %', v_remaining using errcode = 'check_violation';
  end if;

  select max_refund_without_approval_cents into v_threshold from public.business_settings where id;
  if v_threshold is not null and p_amount_cents > v_threshold
     and not (app.has_perm('payments.approve_refund') or app.can_write()) then
    raise exception 'refund_needs_approval: max % without manager approval', v_threshold
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.refunds
    (payment_id, order_id, amount_cents, reason, method, requested_by, approved_by, portal_id)
  values
    (p_payment_id, v_pay.order_id, p_amount_cents, trim(p_reason),
     coalesce(nullif(p_method, ''), v_pay.method), app.jwt_sub(),
     case when v_threshold is not null and p_amount_cents > v_threshold then app.jwt_sub() else null end,
     app.current_portal_id())
  returning * into v_ref;

  update public.payments
     set refunded_cents = refunded_cents + p_amount_cents,
         status = case when refunded_cents + p_amount_cents >= amount_cents
                       then 'refunded' else 'partially_refunded' end
   where id = p_payment_id;

  if v_pay.order_id is not null then
    update public.orders
       set refunded_cents = coalesce(refunded_cents, 0) + p_amount_cents, updated_at = now()
     where id = v_pay.order_id;
  end if;
  return v_ref;
end $fn$;
revoke all on function public.refund_payment(uuid, int, text, text) from public;
grant execute on function public.refund_payment(uuid, int, text, text) to authenticated, service_role;
