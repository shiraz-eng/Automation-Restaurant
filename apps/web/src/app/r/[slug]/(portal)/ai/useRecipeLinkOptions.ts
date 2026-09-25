'use client';

import { useEffect, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

/** What the AI import reviews offer for linking recipes and dishes — always
 *  the reviewer's explicit choice; the server's link_recipe() re-checks
 *  every pick. Read with the reviewer's own session (RLS applies). */
export type DishOption = {
  id: string;
  name: string;
  sizes: { id: string; name: string }[];
  /** '' = the whole dish; a size id = that size. Slots that already have a recipe. */
  takenSlots: Set<string>;
};
export type RecipeOption = { id: string; name: string; status: 'draft' | 'active' };

type RecipeRow = { id: string; name: string; status: string; recipe_type: string; menu_item_id: string | null; variant_id: string | null };
type DishRow = { id: string; name: string; menu_variants: { id: string; name: string; sort_order: number }[] | null };

export function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function useRecipeLinkOptions(enabled: boolean) {
  const supabase = usePortalSupabase();
  const [dishes, setDishes] = useState<DishOption[]>([]);
  const [unlinkedRecipes, setUnlinkedRecipes] = useState<RecipeOption[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const [{ data: recipes }, { data: items }] = await Promise.all([
        supabase.from('recipes').select('id, name, status, recipe_type, menu_item_id, variant_id').neq('status', 'archived'),
        supabase.from('menu_items').select('id, name, menu_variants(id, name, sort_order)').order('name'),
      ]);
      if (cancelled) return;
      const rows = (recipes ?? []) as RecipeRow[];
      setUnlinkedRecipes(
        rows
          .filter((r) => !r.menu_item_id && r.recipe_type === 'menu_item')
          .map((r) => ({ id: r.id, name: r.name, status: r.status as RecipeOption['status'] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setDishes(
        ((items ?? []) as DishRow[]).map((d) => ({
          id: d.id,
          name: d.name,
          sizes: (d.menu_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order).map((v) => ({ id: v.id, name: v.name })),
          takenSlots: new Set(rows.filter((r) => r.menu_item_id === d.id).map((r) => r.variant_id ?? '')),
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, supabase]);

  return { dishes, unlinkedRecipes };
}
