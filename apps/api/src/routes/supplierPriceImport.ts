import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { aiEnabled, env } from '../env';
import { extractPdfText } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureSupplierPricesFromText,
  validateParsedSupplierPrices,
  diffSupplierPriceImport,
  fetchPriceImportContext,
  type ParsedSupplierPrices,
  type SupplierPriceImportDiff,
} from '../lib/supplierPriceImport';

export const supplierPriceImportRouter = express.Router();

supplierPriceImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const createSchema = z.object({ slug: z.string().min(1), storagePath: z.string().min(1), filename: z.string().min(1).max(200) });

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

supplierPriceImportRouter.post('/supplier-price-import', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { storagePath, filename } = parsed.data;

  const { data: fileBlob, error: dlErr } = await admin.storage.from('ai-imports').download(storagePath);
  if (dlErr || !fileBlob) return res.status(404).json({ error: 'file_not_found', message: 'Could not find the uploaded file.' });
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file_too_large', message: 'File must be under 10 MB.' });

  let rawText: string;
  try {
    rawText = isPdf(filename) ? await extractPdfText(buffer) : extractPlainText(buffer);
  } catch (err) {
    console.error('[supplier-price-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file.' });
  }
  if (!rawText.trim()) return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });

  let structured: ParsedSupplierPrices;
  try {
    structured = await structureSupplierPricesFromText(rawText);
  } catch (err) {
    console.error('[supplier-price-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a price list.' });
  }

  const issues = validateParsedSupplierPrices(structured);
  if (structured.rows.length === 0) return res.status(422).json({ error: 'validation_failed', issues });

  const ctx = await fetchPriceImportContext(admin);
  const diff: SupplierPriceImportDiff = diffSupplierPriceImport(structured, ctx);

  const { data: draft, error: insErr } = await admin
    .from('supplier_price_import_drafts')
    .insert({ source_filename: filename, storage_path: storagePath, extracted_json: structured, diff_json: diff, status: 'ready_for_review', created_by: userId })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[supplier-price-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_price_import_drafted', entity: 'supplier_price_import_drafts', entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid(), approvedItemKeys: z.array(z.string()).min(1).max(500) });

supplierPriceImportRouter.post('/supplier-price-import/apply', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('supplier_price_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });

  const diff = draft.diff_json as SupplierPriceImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { catalog_entries_created: 0, prices_updated: 0, skipped: [] as string[] };

  try {
    for (let i = 0; i < diff.rows.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.rows[i]!;
      if (!row.matched_supplier_id || !row.matched_inventory_item_id || row.price_cents == null) {
        result.skipped.push(`${row.supplier_name} / ${row.item_name} — no longer resolves`);
        continue;
      }

      const { data: liveExisting } = await admin
        .from('supplier_items')
        .select('id, current_price_cents')
        .eq('supplier_id', row.matched_supplier_id)
        .eq('inventory_item_id', row.matched_inventory_item_id)
        .maybeSingle();

      if (liveExisting) {
        if (liveExisting.current_price_cents !== row.price_cents) {
          const { error: priceErr } = await admin.rpc('set_supplier_item_price', {
            p_supplier_item_id: liveExisting.id,
            p_new_price_cents: row.price_cents,
            // supplier_price_history.source is check-constrained to
            // ('manual','purchase_order','invoice') — 'manual' is correct
            // here: a human reviewed and approved this exact change before
            // it was applied, same as update_supplier_price's chat action.
            p_source: 'manual',
          });
          if (priceErr) throw priceErr;
          result.prices_updated += 1;
        }
        const patch: Record<string, unknown> = {};
        if (row.purchase_unit_label != null) patch.purchase_unit_label = row.purchase_unit_label;
        if (row.purchase_unit_to_base != null) patch.purchase_unit_to_base = row.purchase_unit_to_base;
        if (row.moq != null) patch.moq = row.moq;
        if (row.lead_time_days != null) patch.lead_time_days = row.lead_time_days;
        if (Object.keys(patch).length > 0) {
          const { error: upErr } = await admin.from('supplier_items').update(patch).eq('id', liveExisting.id);
          if (upErr) throw upErr;
        }
      } else {
        const { error: insErr } = await admin.from('supplier_items').insert({
          supplier_id: row.matched_supplier_id,
          inventory_item_id: row.matched_inventory_item_id,
          supplier_item_name: row.item_name,
          purchase_unit_label: row.purchase_unit_label,
          purchase_unit_to_base: row.purchase_unit_to_base ?? 1,
          current_price_cents: row.price_cents,
          moq: row.moq,
          lead_time_days: row.lead_time_days,
        });
        if (insErr) throw insErr;
        result.catalog_entries_created += 1;
      }
    }
  } catch (err) {
    console.error('[supplier-price-import] apply failed partway:', err);
    await admin.from('supplier_price_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the price import failed partway through.', partial: result });
  }

  await admin.from('supplier_price_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_price_import_applied', entity: 'supplier_price_import_drafts', entity_id: draftId, after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

supplierPriceImportRouter.post('/supplier-price-import/reject', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('supplier_price_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('supplier_price_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_price_import_rejected', entity: 'supplier_price_import_drafts', entity_id: draft.id,
  });
  return res.json({ ok: true });
});
