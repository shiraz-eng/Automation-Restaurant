import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureTablesFromText,
  validateParsedTables,
  diffTableImport,
  fetchExistingTables,
  type ParsedTables,
  type TableImportDiff,
} from '../lib/tableImport';

export const tableImportRouter = express.Router();

tableImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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

tableImportRouter.post('/table-import', express.json(), requirePortalPerm('tables.update'), async (req: Request, res: Response) => {
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
    console.error('[table-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file.' });
  }
  if (!rawText.trim()) {
    return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });
  }

  let structured: ParsedTables;
  try {
    structured = await structureTablesFromText(rawText);
  } catch (err) {
    console.error('[table-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a table list.' });
  }

  const issues = validateParsedTables(structured);
  if (structured.tables.length === 0) {
    return res.status(422).json({ error: 'validation_failed', issues });
  }

  const existing = await fetchExistingTables(admin);
  const diff: TableImportDiff = diffTableImport(structured, existing);

  const { data: draft, error: insErr } = await admin
    .from('table_import_drafts')
    .insert({ source_filename: filename, storage_path: storagePath, extracted_json: structured, diff_json: diff, status: 'ready_for_review', created_by: userId })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[table-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.table_import_drafted', entity: 'table_import_drafts', entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({
  slug: z.string().min(1),
  draftId: z.string().uuid(),
  approvedItemKeys: z.array(z.string()).min(1).max(500),
});

tableImportRouter.post('/table-import/apply', express.json(), requirePortalPerm('tables.update'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('table_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') {
    return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
  }

  const diff = draft.diff_json as TableImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const result = { tables_created: 0, skipped: [] as string[] };

  const { count } = await admin.from('restaurant_tables').select('id', { count: 'exact', head: true });
  let nextSort = (count ?? 0) + 1;

  try {
    for (let i = 0; i < diff.tables.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.tables[i]!;

      const { data: liveExisting } = await admin.from('restaurant_tables').select('id').ilike('label', row.label).maybeSingle();
      if (liveExisting) {
        result.skipped.push(`${row.label} — already exists`);
        continue;
      }
      const { error: insErr } = await admin.from('restaurant_tables').insert({ label: row.label, seats: row.seats, sort_order: nextSort });
      if (insErr) throw insErr;
      nextSort += 1;
      result.tables_created += 1;
    }
  } catch (err) {
    console.error('[table-import] apply failed partway:', err);
    await admin.from('table_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the table import failed partway through.', partial: result });
  }

  await admin.from('table_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.table_import_applied', entity: 'table_import_drafts', entity_id: draftId, after: result,
  });

  return res.json({ ok: true, result });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

tableImportRouter.post('/table-import/reject', express.json(), requirePortalPerm('tables.update'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('table_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('table_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.table_import_rejected', entity: 'table_import_drafts', entity_id: draft.id,
  });
  return res.json({ ok: true });
});
