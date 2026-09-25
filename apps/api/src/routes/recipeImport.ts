import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm, permits } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText, extractionDetail } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureRecipesFromText,
  validateParsedRecipes,
  diffRecipeImport,
  fetchRecipeImportContext,
  convertToBaseUnit,
  recipeNameKey,
  type ParsedRecipes,
  type RecipeImportDiff,
} from '../lib/recipeImport';

/**
 * AI recipe import — the third domain on aiDocumentEngine.ts (menu, then
 * inventory, now recipes). Two permissions can manage recipes (spec: the
 * manual Recipes page accepts inventory.manage_recipes OR
 * finance.manage_recipes) so this router uses the broad 'menu.view' gate
 * (same base bar the Recipes page itself uses) and checks the OR inside
 * each handler, matching the pattern routes/ai.ts already uses for its own
 * multi-permission gates rather than requirePortalPerm's single-string
 * shape.
 */
export const recipeImportRouter = express.Router();

recipeImportRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

function canManageRecipes(permissions: string[], role: string | null): boolean {
  return permits(permissions, role, 'inventory.manage_recipes') || permits(permissions, role, 'finance.manage_recipes');
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const createSchema = z.object({
  slug: z.string().min(1),
  storagePath: z.string().min(1),
  filename: z.string().min(1).max(200),
});

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

/**
 * POST /api/ai/recipe-import — downloads the uploaded file from the
 * shared 'ai-imports' bucket, extracts its text, structures it into
 * recipes, resolves every recipe against LIVE menu items/recipes/
 * inventory, and stores the draft for review. Nothing is created yet.
 */
recipeImportRouter.post('/recipe-import', express.json(), requirePortalPerm('menu.view'), async (req: Request, res: Response) => {
  const { permissions, role } = req.tenant!;
  if (!canManageRecipes(permissions, role)) {
    return res.status(403).json({ error: 'forbidden', message: "You don't have permission to manage recipes." });
  }
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role: actorRole } = req.tenant!;
  const { storagePath, filename } = parsed.data;

  const { data: fileBlob, error: dlErr } = await admin.storage.from('ai-imports').download(storagePath);
  if (dlErr || !fileBlob) {
    return res.status(404).json({ error: 'file_not_found', message: 'Could not find the uploaded file.' });
  }
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return res.status(413).json({ error: 'file_too_large', message: 'File must be under 10 MB.' });
  }

  let rawText: string;
  try {
    rawText = isPdf(filename) ? await extractPdfText(buffer) : extractPlainText(buffer);
  } catch (err) {
    console.error('[recipe-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file — it may be corrupted, or a binary format that isn\'t supported yet. Export as plain text or PDF and try again.', detail: extractionDetail(err) });
  }
  if (!rawText.trim()) {
    return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });
  }

  let structured: ParsedRecipes;
  try {
    structured = await structureRecipesFromText(rawText);
  } catch (err) {
    console.error('[recipe-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a set of recipes.' });
  }

  const issues = validateParsedRecipes(structured);
  if (structured.recipes.length === 0) {
    return res.status(422).json({ error: 'validation_failed', issues });
  }

  const ctx = await fetchRecipeImportContext(admin);
  const diff: RecipeImportDiff = diffRecipeImport(structured, ctx);

  const { data: draft, error: insErr } = await admin
    .from('recipe_import_drafts')
    .insert({
      source_filename: filename,
      storage_path: storagePath,
      extracted_json: structured,
      diff_json: diff,
      status: 'ready_for_review',
      created_by: userId,
    })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[recipe-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: actorRole,
    action: 'ai.recipe_import_drafted',
    entity: 'recipe_import_drafts',
    entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({
  slug: z.string().min(1),
  draftId: z.string().uuid(),
  approvedItemKeys: z.array(z.string()).min(1).max(500),
});

/**
 * POST /api/ai/recipe-import/apply — re-fetches the draft and re-resolves
 * every approved row FRESH against live data (a manual recipe/menu edit
 * between draft and apply is exactly the conflict this catches — in
 * particular, a recipe someone created by hand in the meantime must not
 * get a silent duplicate). Creates each approved recipe through the SAME
 * create_recipe() RPC the manual Recipes page and the AI chat's
 * draft_recipe action use — never a raw table insert — so it always lands
 * as a draft, subject to the exact same validation and permission checks.
 */
recipeImportRouter.post('/recipe-import/apply', express.json(), requirePortalPerm('menu.view'), async (req: Request, res: Response) => {
  const { permissions, role } = req.tenant!;
  if (!canManageRecipes(permissions, role)) {
    return res.status(403).json({ error: 'forbidden', message: "You don't have permission to manage recipes." });
  }
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role: actorRole } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('recipe_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') {
    return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
  }

  const diff = draft.diff_json as RecipeImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { recipes_created: 0, skipped: [] as string[] };
  const ctx = await fetchRecipeImportContext(admin);

  try {
    for (let i = 0; i < diff.recipes.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.recipes[i]!;

      // Re-resolve fresh rather than trusting the stored diff snapshot.
      if (ctx.existingRecipeNames.has(recipeNameKey(row.recipe_name))) {
        result.skipped.push(`${row.recipe_name} — a recipe with this name already exists`);
        continue;
      }

      const resolvedIngredients: { inventory_item_id: string; qty_base: number }[] = [];
      let ingredientProblem: string | null = null;
      for (const ing of row.ingredients) {
        const inv = ctx.inventoryItems.find((i) => i.id === ing.inventory_item_id);
        if (!inv || ing.qty == null || ing.unit == null) {
          ingredientProblem = `${row.recipe_name} — "${ing.name}" no longer resolves`;
          break;
        }
        const qtyBase = convertToBaseUnit(ing.qty, ing.unit, inv.unit);
        if (qtyBase == null) {
          ingredientProblem = `${row.recipe_name} — "${ing.name}" unit no longer converts`;
          break;
        }
        resolvedIngredients.push({ inventory_item_id: inv.id, qty_base: qtyBase });
      }
      if (ingredientProblem) {
        result.skipped.push(ingredientProblem);
        continue;
      }
      if (resolvedIngredients.length === 0) {
        result.skipped.push(`${row.recipe_name} — no ingredients`);
        continue;
      }

      // Created unlinked: the dish is linked by hand from the Menu.
      const { error: rpcErr } = await admin.rpc('create_recipe', {
        p_name: row.recipe_name,
        p_description: row.menu_item_name ? `For ${row.menu_item_name}${row.variant_name ? ` · ${row.variant_name}` : ''} (per the imported document)` : null,
        p_notes: 'Created by AI recipe import — review, activate, then link it to a dish from Menu.',
        p_recipe_type: 'menu_item',
        p_menu_item_id: null,
        p_variant_id: null,
        p_instructions: row.instructions,
        p_yield_qty: row.yield_qty,
        p_yield_unit: row.yield_unit,
        p_ingredients: resolvedIngredients,
      });
      if (rpcErr) {
        result.skipped.push(`${row.recipe_name} — ${rpcErr.message}`);
        continue;
      }
      result.recipes_created += 1;
      // Keep the in-memory context consistent for any later row in this
      // same batch with the same name.
      ctx.existingRecipeNames.add(recipeNameKey(row.recipe_name));
    }
  } catch (err) {
    console.error('[recipe-import] apply failed partway:', err);
    await admin.from('recipe_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the recipe import failed partway through — see the exact result below.', partial: result });
  }

  await admin.from('recipe_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: actorRole,
    action: 'ai.recipe_import_applied',
    entity: 'recipe_import_drafts',
    entity_id: draftId,
    after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

recipeImportRouter.post('/recipe-import/reject', express.json(), requirePortalPerm('menu.view'), async (req: Request, res: Response) => {
  const { permissions, role } = req.tenant!;
  if (!canManageRecipes(permissions, role)) {
    return res.status(403).json({ error: 'forbidden', message: "You don't have permission to manage recipes." });
  }
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role: actorRole } = req.tenant!;
  const { data: draft } = await admin.from('recipe_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('recipe_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: actorRole,
    action: 'ai.recipe_import_rejected',
    entity: 'recipe_import_drafts',
    entity_id: draft.id,
  });
  return res.json({ ok: true });
});
