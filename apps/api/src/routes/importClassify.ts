import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requirePortalPerm } from '../middleware/portalAuth';
import { isAllowedOrigin, aiEnabled, env } from '../env';
import { extractPdfText, extractPlainText } from '../lib/aiDocumentEngine';
import { classifyImportDocument } from '../lib/importClassifier';

/**
 * The single entry point for "I have a document, which AI import does it
 * belong to?" — read-only classification only, gated by the same broad
 * ai.view every AI feature starts from. It never creates a draft or
 * writes anything; the person still confirms the domain (or picks a
 * different one) before the matching domain's own create endpoint runs,
 * which re-extracts and re-structures the file itself and enforces that
 * domain's own real permission independently of this classification.
 */
export const importClassifyRouter = express.Router();

importClassifyRouter.use((req: Request, res: Response, next: NextFunction) => {
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
const bodySchema = z.object({ slug: z.string().min(1), storagePath: z.string().min(1), filename: z.string().min(1).max(200) });
function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

importClassifyRouter.post('/classify-import', express.json(), requirePortalPerm('ai.view'), async (req: Request, res: Response) => {
  if (!aiEnabled) {
    return res.status(503).json({ error: 'ai_not_configured', message: 'The assistant is not configured on this server.' });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: 'invalid_request' });
  const { admin } = req.tenant!;
  const { storagePath, filename } = parsed.data;

  const { data: fileBlob, error: dlErr } = await admin.storage.from('ai-imports').download(storagePath);
  if (dlErr || !fileBlob) return res.status(404).json({ error: 'file_not_found', message: 'Could not find the uploaded file.' });
  const buffer = Buffer.from(await fileBlob.arrayBuffer());
  if (buffer.byteLength > MAX_FILE_BYTES) return res.status(413).json({ error: 'file_too_large', message: 'File must be under 10 MB.' });

  let rawText: string;
  try {
    rawText = isPdf(filename) ? await extractPdfText(buffer) : extractPlainText(buffer);
  } catch (err) {
    console.error('[classify-import] extraction failed:', err);
    return res.status(422).json({ error: 'file_extraction_failed', message: 'Could not read this file.' });
  }
  if (!rawText.trim()) return res.status(422).json({ error: 'file_empty', message: 'No readable text found in this file.' });

  try {
    const result = await classifyImportDocument(rawText);
    return res.json(result);
  } catch (err) {
    console.error('[classify-import] classification failed:', err);
    return res.status(502).json({ error: 'classification_failed', message: 'The assistant could not classify this document.' });
  }
});
