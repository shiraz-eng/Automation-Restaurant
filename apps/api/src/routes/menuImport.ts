import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { aiEnabled, env } from '../env';
import {
  extractPdfText,
  structureMenuFromText,
  validateParsedMenu,
  diffMenu,
  fetchExistingMenu,
  type ParsedMenu,
  type MenuDiff,
} from '../lib/menuImport';

/**
 * AI menu import (spec: "PDF -> AI -> Structured JSON -> Schema Validation
 * -> Business Validation -> Conflict Detection -> Draft -> Approval ->
 * Backend Service -> Database"). A dedicated flow rather than the generic
 * chat tool-call loop — a multi-item batch review doesn't fit a single
 * proposeAction()'s one-summary/one-confirm shape — but it shares every
 * primitive that loop uses: requirePortalPerm() resolves tenant/permissions/
 * user from the JWT exactly as every other route does (never trusted from
 * the client), and applying a draft writes to the SAME menu tables the
 * manual Menu page and place_order()/storefront/Kitchen/AI tools all read.
 */
export const menuImportRouter = express.Router();

menuImportRouter.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (origin === env.APP_URL || /^http:\/\/localhost:\d+$/.test(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return void res.sendStatus(204);
  next();
});

const MAX_PDF_BYTES = 10 * 1024 * 1024;

const createSchema = z.object({
  slug: z.string().min(1),
  storagePath: z.string().min(1),
  filename: z.string().min(1).max(200),
});

/**
 * POST /api/ai/menu-import — downloads the uploaded PDF from the tenant's
 * own private storage (the client uploaded it there directly beforehand,
 * same pattern as menu images), extracts its text, asks the model to
 * structure it, validates the result, diffs it against the LIVE menu, and
 * stores the draft for review. Nothing is written to the menu yet.
 */
menuImportRouter.post('/menu-import', express.json(), requirePortalPerm('menu.create'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { storagePath, filename } = parsed.data;

  const { data: fileBlob, error: dlErr } = await admin.storage.from('menu-imports').download(storagePath);
  if (dlErr || !fileBlob) {
    return res.status(404).json({ error: 'file_not_found', message: 'Could not find the uploaded file.' });
  }
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  if (buffer.byteLength > MAX_PDF_BYTES) {
    return res.status(413).json({ error: 'file_too_large', message: 'File must be under 10 MB.' });
  }

  let rawText: string;
  try {
    rawText = await extractPdfText(buffer);
  } catch (err) {
    console.error('[menu-import] pdf extraction failed:', err);
    return res.status(422).json({ error: 'pdf_extraction_failed', message: 'Could not read this PDF — it may be image-only or corrupted.' });
  }
  if (!rawText.trim()) {
    return res.status(422).json({ error: 'pdf_empty', message: 'No readable text found in this PDF (it may be a scanned image).' });
  }

  let structured: ParsedMenu;
  try {
    structured = await structureMenuFromText(rawText);
  } catch (err) {
    console.error('[menu-import] extraction failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a menu.' });
  }

  const issues = validateParsedMenu(structured);
  if (issues.length > 0 && (!structured.categories || structured.categories.length === 0)) {
    // Nothing usable at all — fail outright rather than store an empty draft.
    return res.status(422).json({ error: 'validation_failed', issues });
  }

  const existingMenu = await fetchExistingMenu(admin);
  const diff: MenuDiff = diffMenu(structured, existingMenu);

  const { data: draft, error: insErr } = await admin
    .from('menu_import_drafts')
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
    console.error('[menu-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.menu_import_drafted',
    entity: 'menu_import_drafts',
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
 * POST /api/ai/menu-import/apply — re-fetches the draft (never trusts a
 * client-resent copy of it), re-validates approval keys against its own
 * stored diff, and writes ONLY the approved items into menu_categories/
 * menu_items/menu_variants/modifier_groups/modifier_options — the exact
 * tables manual creation uses. A variant/modifier with no price (spec §32
 * — never invent one) is skipped and reported, never defaulted to 0/free.
 */
menuImportRouter.post('/menu-import/apply', express.json(), requirePortalPerm('menu.create'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('menu_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') {
    return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
  }

  const diff = draft.diff_json as MenuDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = {
    categories_created: 0,
    items_created: 0,
    items_updated: 0,
    variants_created: 0,
    variants_updated: 0,
    modifier_groups_created: 0,
    modifiers_created: 0,
    skipped_missing_price: [] as string[],
  };

  try {
    for (let ci = 0; ci < diff.categories.length; ci++) {
      const cat = diff.categories[ci]!;
      for (let ii = 0; ii < cat.items.length; ii++) {
        const key = `${ci}-${ii}`;
        if (!approvedSet.has(key)) continue;
        const item = cat.items[ii]!;

        // Category: find-or-create by name (case-insensitive) — never
        // duplicate an existing category just because casing differs.
        let categoryId: string | null = null;
        const { data: existingCat } = await admin.from('menu_categories').select('id').ilike('name', cat.name).maybeSingle();
        if (existingCat) categoryId = existingCat.id;
        else {
          const { data: newCat, error: catErr } = await admin.from('menu_categories').insert({ name: cat.name }).select('id').single();
          if (catErr) throw catErr;
          categoryId = newCat.id;
          result.categories_created += 1;
        }

        // Item: use the draft's own recorded existing_item_id when this was
        // classified 'updated' at diff time, else re-resolve by name now
        // (a manual create between draft and apply is exactly the
        // conflict this re-check catches) — never trust the diff's
        // snapshot as still current.
        const { data: liveExisting } = await admin.from('menu_items').select('id').ilike('name', item.name).maybeSingle();
        let itemId = liveExisting?.id ?? item.existing_item_id;
        if (itemId) {
          const { error: upErr } = await admin.from('menu_items').update({ description: item.description, category_id: categoryId }).eq('id', itemId);
          if (upErr) throw upErr;
          result.items_updated += 1;
        } else {
          const { data: newItem, error: itemErr } = await admin
            .from('menu_items')
            .insert({ name: item.name, description: item.description, category_id: categoryId })
            .select('id')
            .single();
          if (itemErr) throw itemErr;
          itemId = newItem.id;
          result.items_created += 1;
        }

        for (const v of item.variants) {
          if (v.price_cents == null) {
            result.skipped_missing_price.push(`${item.name} · ${v.name}`);
            continue;
          }
          const { data: existingV } = await admin.from('menu_variants').select('id').eq('menu_item_id', itemId).ilike('name', v.name).maybeSingle();
          if (existingV) {
            const { error: vErr } = await admin.from('menu_variants').update({ price_cents: v.price_cents }).eq('id', existingV.id);
            if (vErr) throw vErr;
            result.variants_updated += 1;
          } else {
            const { error: vErr } = await admin.from('menu_variants').insert({ menu_item_id: itemId, name: v.name, price_cents: v.price_cents });
            if (vErr) throw vErr;
            result.variants_created += 1;
          }
        }

        for (const g of item.modifier_groups) {
          const { data: existingGroup } = await admin.from('modifier_groups').select('id').eq('menu_item_id', itemId).ilike('name', g.name).maybeSingle();
          let groupId = existingGroup?.id;
          if (!groupId) {
            const { data: newGroup, error: gErr } = await admin
              .from('modifier_groups')
              .insert({ menu_item_id: itemId, name: g.name, kind: 'multi', min_select: 0 })
              .select('id')
              .single();
            if (gErr) throw gErr;
            groupId = newGroup.id;
            result.modifier_groups_created += 1;
          }
          for (const m of g.modifiers) {
            if (m.price_cents == null) {
              result.skipped_missing_price.push(`${item.name} · ${g.name} · ${m.name}`);
              continue;
            }
            const { data: existingOpt } = await admin.from('modifier_options').select('id').eq('group_id', groupId).ilike('name', m.name).maybeSingle();
            if (!existingOpt) {
              const { error: mErr } = await admin.from('modifier_options').insert({ group_id: groupId, name: m.name, price_cents: m.price_cents });
              if (mErr) throw mErr;
              result.modifiers_created += 1;
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[menu-import] apply failed partway:', err);
    await admin.from('menu_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the menu import failed partway through — see the exact result below.', partial: result });
  }

  await admin.from('menu_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.menu_import_applied',
    entity: 'menu_import_drafts',
    entity_id: draftId,
    after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

menuImportRouter.post('/menu-import/reject', express.json(), requirePortalPerm('menu.create'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('menu_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('menu_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.menu_import_rejected',
    entity: 'menu_import_drafts',
    entity_id: draft.id,
  });
  return res.json({ ok: true });
});
