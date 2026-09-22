-- ============================================================================
-- Tenant delta 0050 — Kitchen stations
--
-- Kitchen Operations (the redesigned /kds board) needs a real, per-item
-- prep-station assignment to filter KOT lines by (Fryer/Grill/Drinks/...),
-- matching the reference design's station tabs. Nothing in this schema
-- modeled "which station makes this" before — it's a single nullable text
-- column on menu_items (not a separate stations table/enum), the same
-- free-text-grouped-into-pills pattern menu_categories already established
-- for grouping, so the Owner can name a station whatever fits their kitchen
-- without a second CRUD surface to maintain. Null means "unassigned" —
-- the board groups those under "Unassigned", never silently drops them.
-- ============================================================================

alter table public.menu_items
  add column if not exists station text;
