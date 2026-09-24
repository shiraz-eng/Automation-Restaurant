'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Field, Input, Select } from '@/components/ui';
import type { Category, RecipeRow } from '../menuTypes';
import { RecipeConnectField, connectRecipe, recipeChoiceError, type RecipeChoice } from './RecipeConnectField';

/** Quick-create: name + price + category (+ optionally its recipe), same
 *  insert-item-then-"Regular"-variant flow the old inline page used.
 *  Everything else (image, description, extra variants, modifiers) is
 *  added in the full Product Editor, opened automatically once this
 *  succeeds. */
export function CreateProductModal({
  categories,
  recipes,
  canManageRecipes,
  onClose,
  onCreated,
}: {
  categories: Category[];
  recipes: RecipeRow[];
  canManageRecipes: boolean;
  onClose: () => void;
  onCreated: (itemId: string) => void;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [recipe, setRecipe] = useState<RecipeChoice>({ mode: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the product was created but its recipe couldn't be connected:
  // the product is real, so the next step is "continue", not "retry".
  const [createdId, setCreatedId] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (createdId) {
      onCreated(createdId);
      return;
    }
    const cents = Math.round(parseFloat(price) * 100);
    if (!name.trim() || Number.isNaN(cents) || cents < 0) {
      setError('Enter a name and a valid price.');
      return;
    }
    const choiceErr = recipeChoiceError(recipe);
    if (choiceErr) {
      setError(choiceErr);
      return;
    }
    setBusy(true);
    setError(null);
    const { data: item, error: iErr } = await supabase
      .from('menu_items')
      .insert({ name: name.trim(), price_cents: 0, category_id: categoryId || null, is_available: true })
      .select('id')
      .single();
    if (iErr || !item) {
      setBusy(false);
      setError(iErr?.message ?? 'Could not add product.');
      return;
    }
    const { error: vErr } = await supabase
      .from('menu_variants')
      .insert({ menu_item_id: item.id, name: 'Regular', price_cents: cents, sort_order: 0 });
    if (vErr) {
      setBusy(false);
      setError(vErr.message);
      return;
    }
    const recipeErr = canManageRecipes ? await connectRecipe(supabase, recipes, item.id, name.trim(), recipe) : null;
    setBusy(false);
    router.refresh();
    if (recipeErr) {
      setCreatedId(item.id);
      setError(`"${name.trim()}" was created, but its recipe wasn't connected: ${recipeErr}`);
      return;
    }
    onCreated(item.id);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-black text-sm">Add Product</h2>
          <button onClick={onClose} className="text-muted hover:text-body" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={create} className="space-y-3">
          <fieldset disabled={!!createdId} className="space-y-3">
            <Field label="Name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Crispy Chicken Burger" />
            </Field>
            <Field label="Starting Price">
              <Input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Category">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">— none —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            {canManageRecipes && <RecipeConnectField recipes={recipes} value={recipe} onChange={setRecipe} />}
          </fieldset>
          {error && <p className="text-danger text-xs">{error}</p>}
          <p className="text-[11px] text-muted">Creates the product with a &ldquo;Regular&rdquo; variant. Add image, description, sizes and modifiers next.</p>
          <div className="flex gap-2 pt-1">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : createdId ? 'Continue to product' : 'Create Product'}
            </Button>
            {!createdId && (
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
