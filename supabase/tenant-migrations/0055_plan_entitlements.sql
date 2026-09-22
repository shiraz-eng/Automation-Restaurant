-- ============================================================================
-- 0055_plan_entitlements.sql
--
-- Real feature-tier enforcement needs the tenant's own database to know its
-- own plan — until now that lived ONLY in the control plane (subscriptions
-- table), so nothing inside a tenant's project could ever check it. Adds a
-- thin, synced copy (plan_tier/plan_features) kept current by the API layer
-- whenever the control-plane tier/status changes (Stripe webhook, or an
-- admin plan edit) — see apps/api/src/lib/entitlementSync.ts.
--
-- Only ONE feature gets real DB-level enforcement here: menu.branded (Brand
-- Kit). The other enforceable keys (kds.realtime, kds.station_routing,
-- inventory.recipe_deduction) are read-side conveniences gated in the
-- frontend instead — there's no write to block for them the way Brand Kit's
-- brand_* columns are an obvious, single write surface.
-- ============================================================================

alter table public.business_settings add column if not exists plan_tier text;
alter table public.business_settings add column if not exists plan_features text[] not null default '{}';

comment on column public.business_settings.plan_tier is
  'Synced from the control-plane subscription — see apps/api/src/lib/entitlementSync.ts. Not writable by tenant staff.';
comment on column public.business_settings.plan_features is
  'Synced from public.plans.features for this tenant''s current tier — the enforceable subset (packages/shared ENFORCEABLE_FEATURES), not the full marketing list.';

create or replace function app.enforce_plan_entitlements()
returns trigger language plpgsql as $fn$
begin
  -- business_settings' own mgr_write RLS policy lets anyone holding
  -- settings.update (e.g. the Owner) write ANY column on this row —
  -- without this check, a tenant could simply set plan_features itself
  -- and hand itself entitlements it doesn't actually have. Only the
  -- service-role sync (entitlementSync.ts) may ever change these two.
  if app.jwt_role() is distinct from 'service_role' then
    if new.plan_tier is distinct from old.plan_tier
    or new.plan_features is distinct from old.plan_features
    then
      raise exception 'plan_tier/plan_features are managed by the platform and cannot be changed directly'
        using errcode = '42501';
    end if;
  end if;

  if not ('menu.branded' = any(coalesce(new.plan_features, '{}'))) then
    if new.brand_logo_url      is distinct from old.brand_logo_url
    or new.brand_primary       is distinct from old.brand_primary
    or new.brand_primary_fg    is distinct from old.brand_primary_fg
    or new.brand_bg_main       is distinct from old.brand_bg_main
    or new.brand_bg_surface    is distinct from old.brand_bg_surface
    or new.brand_border        is distinct from old.brand_border
    or new.brand_text_body     is distinct from old.brand_text_body
    or new.brand_text_muted    is distinct from old.brand_text_muted
    or new.brand_radius        is distinct from old.brand_radius
    or new.brand_appearance    is distinct from old.brand_appearance
    then
      raise exception 'menu.branded is not included in this restaurant''s current plan'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

drop trigger if exists enforce_plan_entitlements_brand on public.business_settings;
create trigger enforce_plan_entitlements_brand
  before update on public.business_settings
  for each row execute function app.enforce_plan_entitlements();
