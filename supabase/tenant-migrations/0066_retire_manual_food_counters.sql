-- 0066: retire the legacy per-size manual food counters.
--
-- Before availability became automatic (0052/0060), the kitchen's Food Stock
-- panel typed a portion count per size into menu_variants.available_qty and
-- switched track_availability on. That panel is gone, but the counters it
-- left behind were still enforced: place_order refused the size once the
-- count reached 0 ("item_unavailable") and the Menu showed it as Sold Out,
-- even with plenty of ingredients in stock. product_availability (recipes x
-- live inventory, with priority allocation) is the single source of truth
-- now, so the old counters are switched off everywhere.
--
-- menu_variants.is_available (the manual "take off sale" switch) is left
-- exactly as it is — a size someone deliberately hid stays hidden.

update public.menu_variants
   set track_availability = false
 where track_availability;

-- Nothing in the app calls these any more; they were the only writers that
-- turned the counter back on. Kept for the service role (history/backfills)
-- but no longer callable by signed-in users or portals.
revoke execute on function public.set_food_stock(uuid, int, text, text) from authenticated;
revoke execute on function public.record_waste(uuid, int, text, text) from authenticated;
