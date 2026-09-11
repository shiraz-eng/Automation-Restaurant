-- 0025: AI Management's first deterministic automation — automatic
-- low-stock supplier email. The trigger is plain SQL, not an AI decision:
-- it must keep working even if the AI model is unreachable. Reuses the
-- supplier/payables engine (0022) for the preferred-supplier lookup —
-- supplier_items.is_preferred, suppliers.email — rather than a new link.

alter table public.inventory_items
  add column if not exists target_stock_qty numeric(14,3),
  add column if not exists auto_reorder_email boolean not null default true;

alter table public.purchasing_settings
  add column if not exists low_stock_email_enabled boolean not null default false;

do $$ begin
  create type app.low_stock_event_status as enum ('open', 'resolved');
exception when duplicate_object then null; end $$;

create table if not exists public.low_stock_events (
  id                uuid primary key default gen_random_uuid(),
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  status            app.low_stock_event_status not null default 'open',
  stock_at_open     numeric(14,3) not null,
  threshold_at_open numeric(14,3) not null,
  opened_at         timestamptz not null default now(),
  resolved_at       timestamptz
);
create unique index if not exists low_stock_events_one_open_idx on public.low_stock_events(inventory_item_id) where status = 'open';
create index if not exists low_stock_events_item_idx on public.low_stock_events(inventory_item_id, opened_at desc);
alter table public.low_stock_events enable row level security;
drop policy if exists staff_read on public.low_stock_events;
create policy staff_read on public.low_stock_events for select using (app.has_perm('stock.view') or app.is_staff());

create or replace function app.sync_low_stock_event() returns trigger
language plpgsql set search_path = public, app as $fn$
declare v_open_id uuid;
begin
  select id into v_open_id from public.low_stock_events
   where inventory_item_id = new.id and status = 'open';
  if new.stock_qty <= new.min_threshold then
    if v_open_id is null then
      insert into public.low_stock_events (inventory_item_id, stock_at_open, threshold_at_open)
      values (new.id, new.stock_qty, new.min_threshold);
    end if;
  elsif v_open_id is not null then
    update public.low_stock_events set status = 'resolved', resolved_at = now() where id = v_open_id;
  end if;
  return new;
end $fn$;
drop trigger if exists sync_low_stock_event on public.inventory_items;
create trigger sync_low_stock_event after update of stock_qty, min_threshold on public.inventory_items
  for each row execute function app.sync_low_stock_event();

create table if not exists public.supplier_communications (
  id                 uuid primary key default gen_random_uuid(),
  supplier_id        uuid not null references public.suppliers(id) on delete cascade,
  inventory_item_id  uuid references public.inventory_items(id) on delete set null,
  low_stock_event_id uuid references public.low_stock_events(id) on delete set null,
  kind               text not null default 'low_stock_reorder' check (kind in ('low_stock_reorder')),
  subject            text not null,
  body               text not null,
  recipient_email    text not null,
  suggested_qty      numeric(14,3),
  status             text not null default 'pending' check (status in ('pending','sent','failed')),
  provider           text,
  error              text,
  sent_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists supplier_communications_supplier_idx on public.supplier_communications(supplier_id, created_at desc);
create index if not exists supplier_communications_event_idx on public.supplier_communications(low_stock_event_id);
alter table public.supplier_communications enable row level security;
drop policy if exists staff_read on public.supplier_communications;
create policy staff_read on public.supplier_communications for select using (app.has_perm('payables.view') or app.has_perm('supplier.view') or app.is_staff());

create or replace function public.pending_low_stock_reorders()
returns table (
  low_stock_event_id uuid, inventory_item_id uuid, item_name text, unit text,
  stock_qty numeric, min_threshold numeric, target_stock_qty numeric, suggested_qty numeric,
  supplier_id uuid, supplier_name text, supplier_email text
)
language plpgsql stable security definer set search_path = public, app as $fn$
begin
  if not (app.has_perm('supplier.view') or app.can_write()) then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  return query
    select lse.id, ii.id, ii.name, ii.unit,
           ii.stock_qty, ii.min_threshold, ii.target_stock_qty,
           greatest(0, coalesce(ii.target_stock_qty, 0) - ii.stock_qty),
           s.id, s.name, s.email
      from public.low_stock_events lse
      join public.inventory_items ii on ii.id = lse.inventory_item_id
      join public.supplier_items si on si.inventory_item_id = ii.id and si.is_preferred and si.is_active
      join public.suppliers s on s.id = si.supplier_id and s.is_active
      cross join public.purchasing_settings ps
     where lse.status = 'open'
       and ii.auto_reorder_email
       and ps.low_stock_email_enabled
       and ii.target_stock_qty is not null
       and s.email is not null and s.email <> ''
       and not exists (
         select 1 from public.supplier_communications sc
          where sc.low_stock_event_id = lse.id and sc.status = 'sent'
       );
end $fn$;
revoke all on function public.pending_low_stock_reorders() from public;
grant execute on function public.pending_low_stock_reorders() to authenticated, service_role;
