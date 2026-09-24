'use client';

import { Field, Input, Select } from '@/components/ui';
import type { usePortalSupabase } from '@/components/PortalProvider';
import type { RecipeRow } from '../menuTypes';

/** How a dish gets its recipe while it's being created (or later, from the
 *  Product Editor when it has none). A menu recipe belongs to exactly one
 *  dish, so "connecting" never moves another dish's recipe — it creates
 *  this dish's own active recipe:
 *   - copy: the same ingredients as an existing dish's recipe
 *   - batch: one portion of a prepared batch (semi-finished/preparation)
 *  Either way the dish deducts stock, shows food cost and gets automatic
 *  availability from its first order. */
export type RecipeChoice = { mode: 'none' } | { mode: 'copy'; recipeId: string } | { mode: 'batch'; recipeId: string; portion: string };

const isBatch = (r: RecipeRow) => r.recipe_type === 'semi_finished' || r.recipe_type === 'preparation';

function currentVersion(r: RecipeRow) {
  return r.recipe_versions.find((v) => v.id === r.current_version_id) ?? null;
}

export function RecipeConnectField({
  recipes,
  value,
  onChange,
}: {
  recipes: RecipeRow[];
  value: RecipeChoice;
  onChange: (c: RecipeChoice) => void;
}) {
  const usable = recipes.filter((r) => r.status === 'active' && currentVersion(r));
  const dishRecipes = usable.filter((r) => !isBatch(r)).sort((a, b) => a.name.localeCompare(b.name));
  const batches = usable.filter(isBatch).sort((a, b) => a.name.localeCompare(b.name));
  const selected = value.mode === 'none' ? '' : `${value.mode}:${value.recipeId}`;
  const batch = value.mode === 'batch' ? usable.find((r) => r.id === value.recipeId) : undefined;
  const unit = batch ? (currentVersion(batch)?.yield_unit ?? 'portion') : '';

  return (
    <div className="space-y-2">
      <Field label="Recipe">
        <Select
          value={selected}
          onChange={(e) => {
            const [mode, recipeId] = e.target.value.split(':');
            if (mode === 'copy') onChange({ mode: 'copy', recipeId });
            else if (mode === 'batch') onChange({ mode: 'batch', recipeId, portion: '' });
            else onChange({ mode: 'none' });
          }}
        >
          <option value="">No recipe for now</option>
          {dishRecipes.length > 0 && (
            <optgroup label="Same ingredients as">
              {dishRecipes.map((r) => (
                <option key={r.id} value={`copy:${r.id}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          {batches.length > 0 && (
            <optgroup label="Serve a portion of a prepared batch">
              {batches.map((r) => (
                <option key={r.id} value={`batch:${r.id}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>
      {value.mode === 'batch' && (
        <Field label={`Portion per serving (${unit})`}>
          <Input
            type="number"
            min="0.001"
            step="0.001"
            value={value.portion}
            onChange={(e) => onChange({ ...value, portion: e.target.value })}
            placeholder="250"
          />
        </Field>
      )}
      <p className="text-[11px] text-muted">
        {value.mode === 'none'
          ? usable.length === 0
            ? 'No active recipes yet — build one on the Recipes page to track stock and food cost.'
            : 'Connect a recipe so this dish deducts stock, shows food cost and goes unavailable automatically when ingredients run out.'
          : value.mode === 'copy'
            ? 'This dish gets its own recipe with the same ingredients. Adjust it any time on the Recipes page.'
            : `Each serving uses this much of the batch, in the batch's own unit (${unit}).`}
      </p>
    </div>
  );
}

/** Validates the choice before anything is created, so a bad portion never
 *  leaves a half-made product behind. Returns an error message or null. */
export function recipeChoiceError(choice: RecipeChoice): string | null {
  if (choice.mode !== 'batch') return null;
  const n = parseFloat(choice.portion);
  return Number.isFinite(n) && n > 0 ? null : 'Enter the portion per serving for the prepared batch.';
}

/** Creates and activates this dish's recipe from the choice. Uses the same
 *  create_recipe / activate_recipe_version RPCs as the Recipes page, so the
 *  database enforces the recipe permission, not this form. */
export async function connectRecipe(
  supabase: ReturnType<typeof usePortalSupabase>,
  recipes: RecipeRow[],
  menuItemId: string,
  dishName: string,
  choice: RecipeChoice,
): Promise<string | null> {
  if (choice.mode === 'none') return null;
  const source = recipes.find((r) => r.id === choice.recipeId);
  const version = source ? currentVersion(source) : null;
  if (!source || !version) return 'That recipe is no longer active.';

  const ingredients =
    choice.mode === 'copy'
      ? version.recipe_ingredients.map((ing, i) => ({
          inventory_item_id: ing.inventory_item_id,
          sub_recipe_id: ing.sub_recipe_id,
          // A copied recipe that yields several servings is scaled to one.
          qty_base: Math.round((ing.qty_base / Math.max(version.yield_qty, 0.0001)) * 1000) / 1000,
          sort_order: i,
        }))
      : [{ inventory_item_id: null, sub_recipe_id: source.id, qty_base: parseFloat(choice.portion), sort_order: 0 }];

  const { data, error } = await supabase.rpc('create_recipe', {
    p_name: dishName,
    p_description: choice.mode === 'copy' ? `Based on ${source.name}` : `Portion of ${source.name}`,
    p_notes: null,
    p_recipe_type: 'menu_item',
    p_menu_item_id: menuItemId,
    p_variant_id: null,
    p_instructions: null,
    p_yield_qty: 1,
    p_yield_unit: null,
    p_ingredients: ingredients,
  });
  if (error) {
    if (/forbidden/i.test(error.message)) return 'You need recipe-management permission to connect a recipe.';
    if (/recipes_one_live_per_product/i.test(error.message)) return 'This dish already has a draft recipe — finish it on the Recipes page.';
    return error.message;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const versionId = (row as { recipe_version_id?: string } | null)?.recipe_version_id;
  if (!versionId) return 'The recipe was saved as a draft — activate it on the Recipes page.';
  const { error: actErr } = await supabase.rpc('activate_recipe_version', { p_recipe_version_id: versionId });
  return actErr ? `The recipe was saved as a draft, but activating it failed: ${actErr.message}` : null;
}
