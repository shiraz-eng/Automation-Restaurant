import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { IngredientCostPanel } from '../inventory/IngredientCostPanel';
import { RecipesManager, type Recipe, type MenuItemOption, type InventoryItemOption, type SubRecipeOption, type CategoryOption } from './RecipesManager';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Recipes & Food Cost' };

export default async function RecipesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'menu.view');
  const canManage = can(perms, role, 'inventory.manage_recipes') || can(perms, role, 'finance.manage_recipes');
  const canViewCost = can(perms, role, 'inventory.view_cost');

  const [{ data: recipesRaw, error }, { data: menuItems }, { data: inventoryItems }, { data: subRecipes }, { data: categories }] = await Promise.all([
    t.client
      .from('recipes')
      .select(
        'id, name, description, notes, recipe_type, status, instructions, current_version_id, created_at, ' +
          'menu_item_id, variant_id, ' +
          // menu_items.price_cents is vestigial in this schema — the real
          // price always lives on menu_variants, so pull every variant of
          // the linked item and resolve which one prices this recipe
          // (its own variant, or the item's default) client-side.
          'recipe_links(menu_item_id, variant_id, menu_items(name, menu_variants(name, price_cents, sort_order)), menu_variants(name, price_cents)), ' +
          'recipe_versions!recipe_versions_recipe_id_fkey(id, version, status, yield_qty, yield_unit, effective_from, effective_to, ' +
          'recipe_ingredients(id, qty_base, sort_order, inventory_item_id, sub_recipe_id, inventory_items(name, unit, cost_cents_per_base_unit), recipes!recipe_ingredients_sub_recipe_id_fkey(name)), ' +
          'recipe_cost_log(cost_cents, recorded_at))',
      )
      .order('created_at', { ascending: false }),
    t.client.from('menu_items').select('id, name, price_cents, menu_variants(id, name, price_cents)').order('name'),
    t.client
      .from('inventory_items')
      .select(canViewCost ? 'id, name, unit, cost_cents_per_base_unit' : 'id, name, unit')
      .order('name'),
    t.client
      .from('recipes')
      .select('id, name, current_version_id, recipe_versions!recipes_current_version_fk(yield_qty, yield_unit)')
      .in('recipe_type', ['semi_finished', 'preparation'])
      .eq('status', 'active'),
    t.client.from('menu_categories').select('id, name').order('sort_order'),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-black">Recipes</h1>
        <p className="text-muted text-xs mt-1">
          Manage ingredients, quantities, costing and menu item consumption. A recipe is the
          authoritative definition of what a menu item consumes — orders resolve their ingredient
          consumption from whichever version is active here.
        </p>
      </div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <RecipesManager
          recipes={(recipesRaw ?? []) as unknown as Recipe[]}
          menuItems={(menuItems ?? []) as unknown as MenuItemOption[]}
          inventoryItems={(inventoryItems ?? []) as unknown as InventoryItemOption[]}
          subRecipes={(subRecipes ?? []) as unknown as SubRecipeOption[]}
          categories={(categories ?? []) as CategoryOption[]}
          canManage={canManage}
          canViewCost={canViewCost}
        />
      )}
      {can(perms, role, 'finance.manage_costs') && <IngredientCostPanel />}
    </div>
  );
}
