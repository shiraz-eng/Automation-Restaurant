import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText, extractionDetail } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureInventoryFromText,
  validateParsedInventory,
  diffInventory,
  fetchExistingInventory,
  type ParsedInventory,
  type InventoryDiff,
} from '../lib/inventoryImport';

/**
 * AI inventory import — the second domain built on the same document-to-
 * draft engine as AI menu import (spec: "AI should not be designed as
 * menu-import AI. It should become a general restaurant-management action
 * engine"). Shares requirePortalPerm() for tenant/permission resolution and
 * aiDocumentEngine.ts for extraction, exactly like menuImport.ts — the only
 * things that differ are inventoryImport.ts's prompt/schema/diff/apply
 * logic, which is genuinely domain-specific and stays there.
 */
export const inventoryImportRouter = express.Router();

inventoryImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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
 * POST /api/ai/inventory-import — downloads the uploaded file from the
 * tenant's own private 'ai-imports' storage, extracts its text (PDF or
 * plain CSV/text — the extractor is picked by file extension; a genuinely
 * binary format like .xlsx isn't decoded yet, see inventoryImport.ts),
 * asks the model to structure it, validates the result, diffs it against
 * LIVE inventory_items, and stores the draft for review. Nothing is
 * written to inventory yet.
 */
inventoryImportRouter.post('/inventory-import', express.json(), requirePortalPerm('stock.update'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
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
    console.error('[inventory-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file — it may be corrupted, or a binary format (e.g. .xlsx) that isn\'t supported yet. Export as CSV and try again.', detail: extractionDetail(err) });
  }
  if (!rawText.trim()) {
    return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });
  }

  let structured: ParsedInventory;
  try {
    structured = await structureInventoryFromText(rawText);
  } catch (err) {
    console.error('[inventory-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as an inventory list.' });
  }

  const issues = validateParsedInventory(structured);
  if (issues.length > 0 && (!structured.items || structured.items.length === 0)) {
    return res.status(422).json({ error: 'validation_failed', issues });
  }

  const existing = await fetchExistingInventory(admin);
  const diff: InventoryDiff = diffInventory(structured, existing);

  const { data: draft, error: insErr } = await admin
    .from('inventory_import_drafts')
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
    console.error('[inventory-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.inventory_import_drafted',
    entity: 'inventory_import_drafts',
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
 * POST /api/ai/inventory-import/apply — re-fetches the draft, re-resolves
 * each approved row's live existence by name at apply time (a manual
 * create between draft and apply is exactly the conflict this re-check
 * catches), and writes ONLY the approved rows into inventory_items — the
 * exact table the manual Inventory page uses. A new item's opening_stock
 * becomes its stock_qty; an EXISTING item's stock_qty is never touched
 * (see inventoryImport.ts) — only cost/threshold/target are updated, and
 * only the fields the document actually provided (a null field leaves the
 * existing value alone rather than clearing it).
 */
inventoryImportRouter.post('/inventory-import/apply', express.json(), requirePortalPerm('stock.update'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('inventory_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') {
    return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
  }

  const diff = draft.diff_json as InventoryDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { items_created: 0, items_updated: 0, skipped: [] as string[] };

  try {
    for (let i = 0; i < diff.items.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.items[i]!;

      const { data: liveExisting } = await admin.from('inventory_items').select('id').ilike('name', row.name).maybeSingle();
      const itemId = liveExisting?.id ?? row.existing_item_id;

      if (itemId) {
        const patch: Record<string, unknown> = {};
        if (row.cost_cents_per_unit != null) patch.cost_cents_per_base_unit = row.cost_cents_per_unit;
        if (row.min_threshold != null) patch.min_threshold = row.min_threshold;
        if (row.target_stock != null) patch.target_stock_qty = row.target_stock;
        if (Object.keys(patch).length === 0) {
          result.skipped.push(`${row.name} — no changed fields to apply`);
          continue;
        }
        const { error: upErr } = await admin.from('inventory_items').update(patch).eq('id', itemId);
        if (upErr) throw upErr;
        result.items_updated += 1;
      } else {
        const { error: insErr } = await admin.from('inventory_items').insert({
          name: row.name,
          unit: row.unit ?? 'unit',
          stock_qty: row.opening_stock ?? 0,
          cost_cents_per_base_unit: row.cost_cents_per_unit ?? 0,
          min_threshold: row.min_threshold ?? 0,
          target_stock_qty: row.target_stock,
        });
        if (insErr) throw insErr;
        result.items_created += 1;
      }
    }
  } catch (err) {
    console.error('[inventory-import] apply failed partway:', err);
    await admin.from('inventory_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the inventory import failed partway through — see the exact result below.', partial: result });
  }

  await admin.from('inventory_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.inventory_import_applied',
    entity: 'inventory_import_drafts',
    entity_id: draftId,
    after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

inventoryImportRouter.post('/inventory-import/reject', express.json(), requirePortalPerm('stock.update'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('inventory_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('inventory_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId,
    actor_email: email,
    actor_role: role,
    action: 'ai.inventory_import_rejected',
    entity: 'inventory_import_drafts',
    entity_id: draft.id,
  });
  return res.json({ ok: true });
});
