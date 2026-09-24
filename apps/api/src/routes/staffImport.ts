import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText } from '../lib/aiDocumentEngine';
import {
  extractPlainText,
  structureStaffFromText,
  validateParsedStaff,
  diffStaffImport,
  fetchStaffImportContext,
  canGrantRole,
  generateTempPassword,
  type ParsedStaff,
  type StaffImportDiff,
} from '../lib/staffImport';

export const staffImportRouter = express.Router();

staffImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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

staffImportRouter.post('/staff-import', express.json(), requirePortalPerm('staff.create'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role, permissions } = req.tenant!;
  const { storagePath, filename } = parsed.data;

  const { data: fileBlob, error: dlErr } = await admin.storage.from('ai-imports').download(storagePath);
  if (dlErr || !fileBlob) return res.status(404).json({ error: 'file_not_found', message: 'Could not find the uploaded file.' });
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file_too_large', message: 'File must be under 10 MB.' });

  let rawText: string;
  try {
    rawText = isPdf(filename) ? await extractPdfText(buffer) : extractPlainText(buffer);
  } catch (err) {
    console.error('[staff-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file.' });
  }
  if (!rawText.trim()) return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });

  let structured: ParsedStaff;
  try {
    structured = await structureStaffFromText(rawText);
  } catch (err) {
    console.error('[staff-import] structuring failed:', err);
    return res.status(502).json({ error: 'extraction_failed', message: 'The assistant could not interpret this document as a staff list.' });
  }

  const issues = validateParsedStaff(structured);
  if (structured.staff.length === 0) return res.status(422).json({ error: 'validation_failed', issues });

  const ctx = await fetchStaffImportContext(admin);
  const diff: StaffImportDiff = diffStaffImport(structured, ctx, permissions);

  const { data: draft, error: insErr } = await admin
    .from('staff_import_drafts')
    .insert({ source_filename: filename, storage_path: storagePath, extracted_json: structured, diff_json: diff, status: 'ready_for_review', created_by: userId })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[staff-import] failed to store draft:', insErr);
    return res.status(500).json({ error: 'draft_save_failed' });
  }

  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.staff_import_drafted', entity: 'staff_import_drafts', entity_id: draft.id,
    after: { filename, summary: diff.summary },
  });

  return res.status(201).json({ draftId: draft.id, issues, diff });
});

const applySchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid(), approvedItemKeys: z.array(z.string()).min(1).max(500) });

/**
 * POST /api/ai/staff-import/apply — creates a real Auth account + an
 * 'active' membership per approved row, exactly like POST /api/staff.
 * Re-checks BOTH that the email still doesn't exist AND that the
 * APPLYING user's own current permissions cover the target role (the
 * approver's permissions at apply time, not whoever drafted it) before
 * creating anything — the same anti-escalation rule /api/staff/access
 * enforces. Returns each new account's generated temp password ONCE;
 * it is never stored in the draft row or the audit log.
 */
staffImportRouter.post('/staff-import/apply', express.json(), requirePortalPerm('staff.create'), async (req: Request, res: Response) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role, permissions } = req.tenant!;
  const { draftId, approvedItemKeys } = parsed.data;

  const { data: draft, error: fetchErr } = await admin.from('staff_import_drafts').select('*').eq('id', draftId).maybeSingle();
  if (fetchErr || !draft) return res.status(404).json({ error: 'draft_not_found' });
  if (draft.status !== 'ready_for_review') return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });

  const diff = draft.diff_json as StaffImportDiff;
  const approvedSet = new Set(approvedItemKeys);
  const { data: rolesData } = await admin.from('roles').select('key, permissions');
  const rolePermissions = new Map(((rolesData ?? []) as { key: string; permissions: string[] }[]).map((r) => [r.key, r.permissions ?? []]));

  const created: { email: string; full_name: string | null; role: string; temp_password: string }[] = [];
  const skipped: string[] = [];

  try {
    for (let i = 0; i < diff.staff.length; i++) {
      const key = String(i);
      if (!approvedSet.has(key)) continue;
      const row = diff.staff[i]!;
      if (!row.matched_role) {
        skipped.push(`${row.email} — no valid role`);
        continue;
      }
      const rolePerms = rolePermissions.get(row.matched_role) ?? [];
      if (!canGrantRole(permissions, rolePerms)) {
        skipped.push(`${row.email} — exceeds your own permissions`);
        continue;
      }
      const { data: liveExisting } = await admin.from('memberships').select('id').ilike('email', row.email).maybeSingle();
      if (liveExisting) {
        skipped.push(`${row.email} — already exists`);
        continue;
      }

      const tempPassword = generateTempPassword();
      const { data: authUser, error: cErr } = await admin.auth.admin.createUser({
        email: row.email,
        password: tempPassword,
        email_confirm: true,
        app_metadata: { role: row.matched_role },
        user_metadata: row.full_name ? { full_name: row.full_name } : {},
      });
      if (cErr || !authUser?.user) {
        skipped.push(`${row.email} — ${cErr?.message ?? 'account creation failed'}`);
        continue;
      }
      const { error: mErr } = await admin.from('memberships').insert({
        user_id: authUser.user.id,
        email: row.email,
        full_name: row.full_name,
        role: row.matched_role,
        status: 'active',
      });
      if (mErr) {
        skipped.push(`${row.email} — ${mErr.message}`);
        continue;
      }
      created.push({ email: row.email, full_name: row.full_name, role: row.matched_role, temp_password: tempPassword });
    }
  } catch (err) {
    console.error('[staff-import] apply failed partway:', err);
    await admin.from('staff_import_drafts').update({ status: 'failed', error: String((err as Error).message ?? err).slice(0, 500) }).eq('id', draftId);
    return res.status(500).json({ error: 'apply_failed', message: 'Applying the staff import failed partway through.', partial: { created: created.length, skipped } });
  }

  await admin.from('staff_import_drafts').update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId }).eq('id', draftId);
  // Audited WITHOUT the temp passwords — those exist only in this one response.
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.staff_import_applied', entity: 'staff_import_drafts', entity_id: draftId,
    after: { staff_created: created.map((c) => ({ email: c.email, role: c.role })), skipped },
  });

  return res.json({ ok: true, result: { created, skipped } });
});

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

staffImportRouter.post('/staff-import/reject', express.json(), requirePortalPerm('staff.create'), async (req: Request, res: Response) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin, userId, email, role } = req.tenant!;
  const { data: draft } = await admin.from('staff_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
  if (!draft) return res.status(404).json({ error: 'draft_not_found' });
  await admin.from('staff_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
  await admin.from('audit_logs').insert({
    actor_id: userId, actor_email: email, actor_role: role,
    action: 'ai.staff_import_rejected', entity: 'staff_import_drafts', entity_id: draft.id,
  });
  return res.json({ ok: true });
});
