import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled } from '../env';
import { extractDocumentText, extractionDetail } from '../lib/aiDocumentEngine';
import {
  structureInvoiceFromText,
  fetchInvoiceImportContext,
  resolveInvoiceDraft,
  type ParsedInvoice,
} from '../lib/supplierInvoiceImport';

/**
 * AI supplier-invoice import (Finance Phase E).
 *   POST /api/ai/supplier-invoice-import         read the file → draft for review
 *   POST /api/ai/supplier-invoice-import/apply   create the invoice from the REVIEWED draft
 *   POST /api/ai/supplier-invoice-import/reject  discard a draft
 * All need invoices.create. Apply takes the person's corrected values, not
 * the AI's, re-validates every id server-side (supplier, PO belongs to that
 * supplier, PO lines belong to that PO, no duplicate number) and creates the
 * invoice as 'received' only — matching and approval stay separate,
 * permission-checked steps. Nothing here approves or pays.
 */
export const supplierInvoiceImportRouter = express.Router();

supplierInvoiceImportRouter.use((req: Request, res: Response, next: NextFunction) => {
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
const createSchema = z.object({ slug: z.string().min(1), storagePath: z.string().min(1).max(300), filename: z.string().min(1).max(200) });

supplierInvoiceImportRouter.post(
  '/supplier-invoice-import',
  express.json(),
  requirePortalPerm('invoices.create'),
  async (req: Request, res: Response) => {
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
      rawText = await extractDocumentText(buffer, filename);
    } catch (err) {
      console.error('[supplier-invoice-import] extraction failed:', err);
      return res.status(422).json({ error: 'file_extraction_failed', message: `Could not read this file (${extractionDetail(err)}).` });
    }
    if (!rawText.trim()) return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });

    let extracted: ParsedInvoice;
    try {
      extracted = await structureInvoiceFromText(rawText);
    } catch (err) {
      console.error('[supplier-invoice-import] structuring failed:', err);
      return res.status(502).json({
        error: 'extraction_failed',
        message: `The assistant could not read this as a supplier invoice (${extractionDetail(err)}).`,
      });
    }
    if (!extracted.invoice_number && !extracted.supplier_name && extracted.lines.length === 0) {
      return res.status(422).json({ error: 'not_an_invoice', message: "This doesn't look like a supplier invoice." });
    }

    const draft = resolveInvoiceDraft(extracted, await fetchInvoiceImportContext(admin));
    const { data: row, error: insErr } = await admin
      .from('supplier_invoice_import_drafts')
      .insert({ source_filename: filename, storage_path: storagePath, extracted_json: extracted, draft_json: draft, created_by: userId })
      .select('id')
      .single();
    if (insErr || !row) {
      console.error('[supplier-invoice-import] failed to store draft:', insErr);
      return res.status(500).json({ error: 'draft_save_failed' });
    }
    await admin.from('audit_logs').insert({
      actor_id: userId, actor_email: email, actor_role: role,
      action: 'ai.supplier_invoice_drafted', entity: 'supplier_invoice_import_drafts', entity_id: row.id,
      after: { filename, supplier: draft.supplier_name, invoice_number: draft.supplier_invoice_number, status: draft.status },
    });
    return res.status(201).json({ draftId: row.id, draft });
  },
);

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const applySchema = z.object({
  slug: z.string().min(1),
  draftId: z.string().uuid(),
  invoice: z.object({
    supplier_id: z.string().uuid(),
    purchase_order_id: z.string().uuid().nullable(),
    supplier_invoice_number: z.string().trim().min(1).max(80),
    invoice_date: ymd,
    due_date: ymd.nullable(),
    tax_cents: z.number().int().min(0).max(2_000_000_000),
    delivery_cents: z.number().int().min(0).max(2_000_000_000),
    discount_cents: z.number().int().min(0).max(2_000_000_000),
    notes: z.string().max(500).nullable(),
  }),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        qty: z.number().positive().max(10_000_000),
        unit_cost_cents: z.number().int().min(0).max(2_000_000_000),
        po_line_id: z.string().uuid().nullable(),
      }),
    )
    .min(1)
    .max(200),
});

supplierInvoiceImportRouter.post(
  '/supplier-invoice-import/apply',
  express.json(),
  requirePortalPerm('invoices.create'),
  async (req: Request, res: Response) => {
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_request', message: 'Check the supplier, invoice number, date and every line.' });
    }
    const { admin, userId, email, role } = req.tenant!;
    const { draftId, invoice, lines } = parsed.data;

    const { data: draft } = await admin
      .from('supplier_invoice_import_drafts')
      .select('id, status, storage_path, source_filename')
      .eq('id', draftId)
      .maybeSingle();
    if (!draft) return res.status(404).json({ error: 'draft_not_found' });
    if (draft.status !== 'ready_for_review') {
      return res.status(409).json({ error: 'draft_not_pending', message: `This draft is already ${draft.status}.` });
    }

    // Re-validate every id against live data; never trust the browser's.
    const { data: supplier } = await admin.from('suppliers').select('id').eq('id', invoice.supplier_id).eq('is_active', true).maybeSingle();
    if (!supplier) return res.status(422).json({ error: 'bad_supplier', message: 'Choose an active supplier.' });
    if (invoice.purchase_order_id) {
      const { data: po } = await admin.from('purchase_orders').select('supplier_id').eq('id', invoice.purchase_order_id).maybeSingle();
      if (!po || po.supplier_id !== invoice.supplier_id) {
        return res.status(422).json({ error: 'bad_po', message: 'That purchase order is not from this supplier.' });
      }
    }
    const poLineIds = [...new Set(lines.map((l) => l.po_line_id).filter((x): x is string => !!x))];
    const poLineById = new Map<string, { inventory_item_id: string | null }>();
    if (poLineIds.length) {
      const { data: pls } = await admin
        .from('purchase_order_lines')
        .select('id, purchase_order_id, inventory_item_id, purchase_orders(supplier_id)')
        .in('id', poLineIds);
      for (const pl of (pls ?? []) as {
        id: string;
        purchase_order_id: string;
        inventory_item_id: string | null;
        purchase_orders: { supplier_id: string } | { supplier_id: string }[] | null;
      }[]) {
        const poRow = Array.isArray(pl.purchase_orders) ? pl.purchase_orders[0] : pl.purchase_orders;
        const ok = invoice.purchase_order_id ? pl.purchase_order_id === invoice.purchase_order_id : poRow?.supplier_id === invoice.supplier_id;
        if (!ok) return res.status(422).json({ error: 'bad_po_line', message: 'A line is linked to a different purchase order.' });
        poLineById.set(pl.id, { inventory_item_id: pl.inventory_item_id });
      }
      if (poLineById.size !== poLineIds.length) return res.status(422).json({ error: 'bad_po_line', message: 'A linked PO line no longer exists.' });
    }
    const { data: dup } = await admin
      .from('supplier_invoices')
      .select('id, status')
      .eq('supplier_id', invoice.supplier_id)
      .ilike('supplier_invoice_number', invoice.supplier_invoice_number.replace(/[%_\\]/g, (c) => `\\${c}`))
      .maybeSingle();
    if (dup) return res.status(409).json({ error: 'duplicate_invoice', message: `This supplier's invoice ${invoice.supplier_invoice_number} is already recorded.` });

    const rows = lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unit_cost_cents: l.unit_cost_cents,
      line_total_cents: Math.round(l.qty * l.unit_cost_cents),
      po_line_id: l.po_line_id,
      inventory_item_id: l.po_line_id ? (poLineById.get(l.po_line_id)?.inventory_item_id ?? null) : null,
    }));
    const subtotal = rows.reduce((s, r) => s + r.line_total_cents, 0);
    const total = Math.max(0, subtotal + invoice.tax_cents + invoice.delivery_cents - invoice.discount_cents);
    const { data: settings } = await admin.from('business_settings').select('currency_code').maybeSingle();

    const { data: created, error: invErr } = await admin
      .from('supplier_invoices')
      .insert({
        supplier_id: invoice.supplier_id,
        purchase_order_id: invoice.purchase_order_id,
        supplier_invoice_number: invoice.supplier_invoice_number,
        invoice_date: invoice.invoice_date,
        ...(invoice.due_date ? { due_date: invoice.due_date } : {}),
        currency: settings?.currency_code ?? 'USD',
        subtotal_cents: subtotal,
        tax_cents: invoice.tax_cents,
        delivery_fee_cents: invoice.delivery_cents,
        discount_cents: invoice.discount_cents,
        total_cents: total,
        status: 'received',
        notes: invoice.notes ?? 'Read from the supplier invoice by the AI assistant and reviewed before saving.',
        created_by: userId,
      })
      .select('id')
      .single();
    if (invErr || !created) {
      console.error('[supplier-invoice-import] invoice insert failed:', invErr);
      return res.status(500).json({ error: 'invoice_create_failed', message: invErr?.message ?? 'Could not create the invoice.' });
    }
    const { error: linesErr } = await admin.from('supplier_invoice_lines').insert(rows.map((r) => ({ ...r, invoice_id: created.id })));
    if (linesErr) {
      await admin.from('supplier_invoices').delete().eq('id', created.id);
      return res.status(500).json({ error: 'invoice_lines_failed', message: linesErr.message });
    }

    // Keep the supplier's original document with the invoice.
    let attachmentPath: string | null = null;
    const { data: file } = await admin.storage.from('ai-imports').download(draft.storage_path);
    if (file) {
      const safe = draft.source_filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'invoice';
      attachmentPath = `${created.id}/${Date.now()}-${safe}`;
      const { error: upErr } = await admin.storage
        .from('supplier-invoices')
        .upload(attachmentPath, Buffer.from(await file.arrayBuffer()), { contentType: file.type || undefined });
      if (upErr) attachmentPath = null;
      else await admin.from('supplier_invoices').update({ attachment_path: attachmentPath }).eq('id', created.id);
    }

    await admin
      .from('supplier_invoice_import_drafts')
      .update({ status: 'applied', applied_at: new Date().toISOString(), applied_by: userId, invoice_id: created.id })
      .eq('id', draftId);
    await admin.from('audit_logs').insert({
      actor_id: userId, actor_email: email, actor_role: role,
      action: 'ai.supplier_invoice_applied', entity: 'supplier_invoices', entity_id: created.id,
      after: { draft_id: draftId, total_cents: total, lines: rows.length, attachment: !!attachmentPath },
    });
    return res.status(201).json({ ok: true, invoiceId: created.id, totalCents: total });
  },
);

const rejectSchema = z.object({ slug: z.string().min(1), draftId: z.string().uuid() });

supplierInvoiceImportRouter.post(
  '/supplier-invoice-import/reject',
  express.json(),
  requirePortalPerm('invoices.create'),
  async (req: Request, res: Response) => {
    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
    const { admin, userId, email, role } = req.tenant!;
    const { data: draft } = await admin.from('supplier_invoice_import_drafts').select('id, status').eq('id', parsed.data.draftId).maybeSingle();
    if (!draft) return res.status(404).json({ error: 'draft_not_found' });
    if (draft.status === 'ready_for_review') {
      await admin.from('supplier_invoice_import_drafts').update({ status: 'rejected' }).eq('id', draft.id);
    }
    await admin.from('audit_logs').insert({
      actor_id: userId, actor_email: email, actor_role: role,
      action: 'ai.supplier_invoice_discarded', entity: 'supplier_invoice_import_drafts', entity_id: draft.id,
    });
    return res.json({ ok: true });
  },
);
