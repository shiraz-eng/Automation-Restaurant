'use client';

import { Field, Select } from '@/components/ui';
import type { usePortalSupabase } from '@/components/PortalProvider';

/** A dish recipe that isn't linked to any menu item yet — created on the
 *  Recipes page or by AI recipe import. Linking is always a deliberate
 *  choice made here (link_recipe); nothing links itself. */
export type LinkableRecipe = { id: string; name: string; status: 'draft' | 'active' };

type Supabase = ReturnType<typeof usePortalSupabase>;

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
          <option value="">{recipes.length === 0 ? 'No unlinked recipes yet' : 'No recipe'}</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.status === 'draft' ? ' (draft)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-[11px] text-muted">
        {recipes.length === 0
          ? 'Create the recipe on the Recipes page (or import it with AI) first, then link it here.'
          : selected?.status === 'draft'
            ? 'Draft recipe: the dish starts using stock once you activate it on the Recipes page.'
            : 'The dish will deduct this recipe’s ingredients from stock on every order.'}
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

export async function unlinkRecipe(supabase: Supabase, recipeId: string): Promise<string | null> {
  const { error } = await supabase.rpc('unlink_recipe', { p_recipe_id: recipeId });
  return error ? friendly(error.message) : null;
}
