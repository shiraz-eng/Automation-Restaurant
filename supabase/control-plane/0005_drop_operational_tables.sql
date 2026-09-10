-- ============================================================================
-- Control-plane 0005 — enforce the data boundary
--
-- The control plane (sz-hms-production) must hold ONLY platform metadata:
-- tenants, tenant_projects, subscriptions, onboarding_tokens,
-- supabase_connections, oauth_states, contact_messages, webhook_events,
-- and the tenant_directory view.
--
-- These operational tables are leftovers from the pre-pivot RLS shared-schema
-- migrations (supabase/migrations/2026090913*.sql). Nothing writes to them any
-- more — every runtime path targets the restaurant's own dedicated project —
-- and all are empty. Dropping them makes the boundary structural: a stray
-- write to restaurant operational data in the control plane now fails loudly.
-- ============================================================================

drop table if exists public.order_lines        cascade;
drop table if exists public.orders             cascade;
drop table if exists public.order_counter      cascade;
drop table if exists public.stock_ledger       cascade;
drop table if exists public.recipe_components  cascade;
drop table if exists public.menu_items         cascade;
drop table if exists public.menu_categories    cascade;
drop table if exists public.inventory_items    cascade;
drop table if exists public.reservations       cascade;
drop table if exists public.memberships        cascade;
drop table if exists public.outbox             cascade;
drop table if exists public.tenant_counters    cascade;
drop table if exists public.restaurant_tables  cascade;
drop table if exists public.table_sessions     cascade;
drop table if exists public.feedback           cascade;
