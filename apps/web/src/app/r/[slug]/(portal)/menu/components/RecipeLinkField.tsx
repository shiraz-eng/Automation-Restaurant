'use client';

import { Field, Select } from '@/components/ui';
import type { usePortalSupabase } from '@/components/PortalProvider';

/** A dish recipe that can be linked — created on the Recipes page or by AI
 *  import. Any recipe can be picked for any dish or size, even one already
 *  used elsewhere (`uses` = how many dishes/sizes it's linked to). Linking
 *  is always a deliberate choice (link_recipe); nothing links itself. */
export type LinkableRecipe = { id: string; name: string; status: 'draft' | 'active'; uses?: number };

type Supabase = ReturnType<typeof usePortalSupabase>;

export function recipeOptionLabel(r: LinkableRecipe): string {
  const parts: string[] = [];
  if (r.status === 'draft') parts.push('draft');
  if (r.uses) parts.push(`used by ${r.uses}`);
  return parts.length ? `${r.name} (${parts.join(', ')})` : r.name;
}

export function RecipeLinkField({
  recipes,
  value,
  onChange,
  label = 'Link a recipe (optional)',
}: {
  recipes: LinkableRecipe[];
  value: string;
  onChange: (recipeId: string) => void;
  label?: string;
}) {
  const selected = recipes.find((r) => r.id === value);
  return (
    <div className="space-y-1.5">
      <Field label={label}>
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{recipes.length === 0 ? 'No recipes yet' : 'No recipe'}</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {recipeOptionLabel(r)}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-[11px] text-muted">
        {recipes.length === 0
          ? 'Create the recipe on the Recipes page (or import it with AI) first, then link it here.'
          : selected?.status === 'draft'
            ? 'This draft recipe is activated when you link it: stock deduction, food cost and availability switch on.'
            : selected
              ? selected.uses
                ? 'Shared recipe: every dish it’s linked to uses the same ingredients, and a new version updates them all.'
                : 'Stock deduction, food cost and availability switch on for this dish as soon as it’s linked.'
              : 'Linking switches on stock deduction, food cost and automatic availability for this dish.'}
      </p>
    </div>
  );
}

function friendly(message: string): string {
  if (/forbidden/i.test(message)) return 'You need recipe-management permission to link recipes.';
  return message;
}

export async function linkRecipe(supabase: Supabase, recipeId: string, menuItemId: string, variantId: string | null): Promise<string | null> {
  const { error } = await supabase.rpc('link_recipe', { p_recipe_id: recipeId, p_menu_item_id: menuItemId, p_variant_id: variantId });
  return error ? friendly(error.message) : null;
}

/** Unlinks the recipe from one dish/size (or, with no dish, from all). */
export async function unlinkRecipe(
  supabase: Supabase,
  recipeId: string,
  menuItemId?: string,
  variantId?: string | null,
): Promise<string | null> {
  const { error } = await supabase.rpc('unlink_recipe', {
    p_recipe_id: recipeId,
    p_menu_item_id: menuItemId ?? null,
    p_variant_id: variantId ?? null,
  });
  return error ? friendly(error.message) : null;
}
