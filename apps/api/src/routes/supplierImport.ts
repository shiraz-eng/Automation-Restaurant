import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText, extractionDetail } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureSuppliersFromText,
  validateParsedSuppliers,
  diffSupplierImport,
  fetchExistingSuppliers,
  type ParsedSuppliers,
  type SupplierImportDiff,
} from '../lib/supplierImport';

export const supplierImportRouter = express.Router();

supplierImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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

supplierImportRouter.post('/supplier-import', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
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
    console.error('[supplier-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: `Could not read this file (${extractionDetail(err)}).`, detail: extractionDetail(err) });
  }
  if (!rawText.trim()) {
    return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });
  }

  let structured: ParsedSuppliers;
  try {
    structured = await structureSuppliersFromText(rawText);
  } catch (err) {
    console.error('[supplier-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a supplier list.' });
  }

  const issues = validateParsedSuppliers(structured);
  if (structured.suppliers.length === 0) {
    return res.status(422).json({ error: 'validation_failed', issues });
  }

  const existing = await fetchExistingSuppliers(admin);
  const diff: SupplierImportDiff = diffSupplierImport(structured, existing);

  const { data: draft, error: insErr } = await admin
    .from('supplier_import_drafts')
    .insert({ source_filename: filename, storage_path: storagePath, extracted_json: structured, diff_json: diff, status: 'ready_for_review', created_by: userId })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[supplier-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_import_drafted', entity: 'supplier_import_drafts', entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({
  slug: z.string().min(1),
  draftId: z.string().uuid(),
  approvedItemKeys: z.array(z.string()).min(1).max(500),
});

supplierImportRouter.post('/supplier-import/apply', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('supplier_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') {
    return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
  }

  const diff = draft.diff_json as SupplierImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { suppliers_created: 0, skipped: [] as string[] };

  try {
    for (let i = 0; i < diff.suppliers.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.suppliers[i]!;

      const { data: liveExisting } = await admin.from('suppliers').select('id').ilike('name', row.name).maybeSingle();
      if (liveExisting) {
        result.skipped.push(`${row.name} — already exists`);
        continue;
      }
      const { error: insErr } = await admin.from('suppliers').insert({
        name: row.name,
        contact_name: row.contact_name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        payment_terms: row.payment_terms,
        notes: row.notes,
      });
      if (insErr) throw insErr;
      result.suppliers_created += 1;
    }
  } catch (err) {
    console.error('[supplier-import] apply failed partway:', err);
    await admin.from('supplier_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the supplier import failed partway through.', partial: result });
  }

  await admin.from('supplier_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_import_applied', entity: 'supplier_import_drafts', entity_id: draftId, after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

supplierImportRouter.post('/supplier-import/reject', express.json(), requirePortalPerm('supplier.manage'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('supplier_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('supplier_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.supplier_import_rejected', entity: 'supplier_import_drafts', entity_id: draft.id,
  });
  return res.json({ ok: true });
});
