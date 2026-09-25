import { notFound } from 'next/navigation';
import { createTenantServerClient } from '@/lib/supabase/tenant-server';
import { gatePortalPage, can } from '@/lib/permissions';
import { MenuManager } from './MenuManager';
import type { DealRow, ProductAvailabilityRow, RecipeRow } from './menuTypes';

export const dynamic = 'force-dynamic';

export default async function MenuPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await createTenantServerClient(slug);
  if (!t) notFound();

  const { role, perms } = await gatePortalPage(t.client, slug, 'menu.view');
  const canEdit = can(perms, role, 'menu.update');
  const canCreate = can(perms, role, 'menu.create');
  const canDelete = can(perms, role, 'menu.delete');
  const canViewCost = can(perms, role, 'inventory.view_cost');
  const canManageRecipes = can(perms, role, 'inventory.manage_recipes') || can(perms, role, 'finance.manage_recipes');

  // Recipe cost figures are only fetched when the caller actually holds
  // inventory.view_cost — same gate the Recipes & Food Cost page itself
  // uses — so a Manager without that permission never receives ingredient
  // cost data in the page payload, not just a UI that hides it.
  const recipeIngredientsSelect = canViewCost
    ? 'qty_base, inventory_item_id, sub_recipe_id, inventory_items(cost_cents_per_base_unit)'
    : 'qty_base, inventory_item_id, sub_recipe_id';

  const [
    { data: categories },
    { data: items, error },
    { data: ingredients },
    { data: deals },
    { data: recipes },
    { data: availabilityRows },
  ] = await Promise.all([
    t.client.from('menu_categories').select('id, name, sort_order').order('sort_order'),
    t.client
      .from('menu_items')
      .select(
        'id, name, description, price_cents, is_available, category_id, image_url, station, menu_variants(id, name, price_cents, sku, sort_order, is_available, track_availability, available_qty), modifier_groups(id, name, kind, min_select, max_select, sort_order, modifier_options(id, name, price_cents, is_available, sort_order)), recipe_components(id, inventory_item_id, qty_per_unit, variant_id, inventory_items(name, unit))',
      )
      .order('name'),
    t.client.from('inventory_items').select('id, name, unit, stock_qty, min_threshold').order('name'),
    t.client
      .from('deals')
      .select(
        'id, name, price_cents, is_available, deal_components(menu_item_id, variant_id, qty), deal_option_groups(deal_option_items(menu_item_id, variant_id))',
      )
      .eq('is_available', true)
      .order('sort_order'),
    t.client
      .from('recipes')
      .select(
        `id, name, status, recipe_type, menu_item_id, variant_id, current_version_id, recipe_versions!recipe_versions_recipe_id_fkey(id, yield_qty, yield_unit, recipe_ingredients(${recipeIngredientsSelect}))`,
      )
      // Drafts too: a linked draft shows on its dish, an unlinked one can be linked.
      .neq('status', 'archived'),
    t.client.from('product_availability').select('menu_item_id, variant_id, status, producible_qty, bottleneck_inventory_item_id, reason'),
  ]);

  return (
    <div>
      {error ? (
        <div className="rounded-lg border border-danger/40 bg-danger/10 text-danger p-4 text-xs">
          {error.message}
        </div>
      ) : (
        <MenuManager
          slug={slug}
          categories={categories ?? []}
          items={items ?? []}
          ingredients={ingredients ?? []}
          deals={(deals ?? []) as unknown as DealRow[]}
          recipes={(recipes ?? []) as unknown as RecipeRow[]}
          availabilityRows={(availabilityRows ?? []) as ProductAvailabilityRow[]}
          canEdit={canEdit}
          canCreate={canCreate}
          canDelete={canDelete}
          canViewCost={canViewCost}
          canManageRecipes={canManageRecipes}
        />
      )}
    </div>
  );
}
