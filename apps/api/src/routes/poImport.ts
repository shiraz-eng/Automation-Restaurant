import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText, extractionDetail } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structurePOsFromText,
  validateParsedPOs,
  diffPOImport,
  fetchPOImportContext,
  type ParsedPOs,
  type POImportDiff,
} from '../lib/poImport';

export const poImportRouter = express.Router();

poImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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
const createSchema = z.object({ slug: z.string().min(1), storagePath: z.string().min(1), filename: z.string().min(1).max(200) });
function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

/**
 * POST /api/ai/po-import — resolves every order against LIVE suppliers and
 * their OWN supplier_items catalogs (never inventing a price), same rule
 * as the AI chat's draft_purchase_order: if any line in an order doesn't
 * resolve, the WHOLE order is blocked rather than created partially.
 */
poImportRouter.post('/po-import', express.json(), requirePortalPerm('purchases.update'), async (req: Request, res: Response) => {
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
    console.error('[po-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: `Could not read this file (${extractionDetail(err)}).`, detail: extractionDetail(err) });
  }
  if (!rawText.trim()) return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });

  let structured: ParsedPOs;
  try {
    structured = await structurePOsFromText(rawText);
  } catch (err) {
    console.error('[po-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as purchase orders.' });
  }

  const issues = validateParsedPOs(structured);
  if (structured.orders.length === 0) return res.status(422).json({ error: 'validation_failed', issues });

  const ctx = await fetchPOImportContext(admin);
  const diff: POImportDiff = diffPOImport(structured, ctx);

  const { data: draft, error: insErr } = await admin
    .from('po_import_drafts')
    .insert({ source_filename: filename, storage_path: storagePath, extracted_json: structured, diff_json: diff, status: 'ready_for_review', created_by: userId })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[po-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.po_import_drafted', entity: 'po_import_drafts', entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid(), approvedItemKeys: z.array(z.string()).min(1).max(500) });

/**
 * POST /api/ai/po-import/apply — creates each approved order via the SAME
 * next_po_number()+insert pattern the AI chat's draft_purchase_order uses.
 * Every PO lands as a 'draft' (purchase_orders.status default) — nothing
 * is approved or sent here; that stays a separate, human-only step in
 * Purchasing, exactly as for a PO created any other way.
 */
poImportRouter.post('/po-import/apply', express.json(), requirePortalPerm('purchases.update'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('po_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });

  const diff = draft.diff_json as POImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { orders_created: 0, skipped: [] as string[] };

  try {
    for (let i = 0; i < diff.orders.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const po = diff.orders[i]!;
      if (!po.matched_supplier_id || po.lines.some((l) => l.issue || l.inventory_item_id == null || l.unit_cost_cents == null)) {
        result.skipped.push(`${po.supplier_name} — no longer resolves`);
        continue;
      }
      // Re-verify each line's price is still on file (a manual edit
      // between draft and apply is exactly the conflict this re-check
      // catches) rather than trusting the stored diff snapshot.
      const { data: liveSupplierItems } = await admin
        .from('supplier_items')
        .select('inventory_item_id, current_price_cents')
        .eq('supplier_id', po.matched_supplier_id)
        .eq('is_active', true);
      const liveByItem = new Map((liveSupplierItems ?? []).map((si) => [si.inventory_item_id, si.current_price_cents]));
      const stillOk = po.lines.every((l) => liveByItem.has(l.inventory_item_id as string));
      if (!stillOk) {
        result.skipped.push(`${po.supplier_name} — a price is no longer on file`);
        continue;
      }

      const { data: poNumber, error: numErr } = await admin.rpc('next_po_number');
      if (numErr) throw numErr;
      const { data: created, error: poErr } = await admin
        .from('purchase_orders')
        .insert({ po_number: poNumber, supplier_id: po.matched_supplier_id, notes: po.notes ?? 'Drafted by AI purchase order import — review before sending.' })
        .select('id')
        .single();
      if (poErr || !created) throw poErr ?? new Error('purchase_order_create_failed');
      const { error: linesErr } = await admin.from('purchase_order_lines').insert(
        po.lines.map((l) => ({
          purchase_order_id: created.id,
          inventory_item_id: l.inventory_item_id,
          description: l.inventory_item_name ?? l.item_name,
          qty: l.qty,
          unit_cost_cents: liveByItem.get(l.inventory_item_id as string) ?? l.unit_cost_cents,
        })),
      );
      if (linesErr) throw linesErr;
      result.orders_created += 1;
    }
  } catch (err) {
    console.error('[po-import] apply failed partway:', err);
    await admin.from('po_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the purchase order import failed partway through.', partial: result });
  }

  await admin.from('po_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.po_import_applied', entity: 'po_import_drafts', entity_id: draftId, after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

poImportRouter.post('/po-import/reject', express.json(), requirePortalPerm('purchases.update'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('po_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('po_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.po_import_rejected', entity: 'po_import_drafts', entity_id: draft.id,
  });
  return res.json({ ok: true });
});
