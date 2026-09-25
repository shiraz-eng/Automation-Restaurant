'use client';

import { useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type DiffIngredient = { name: string; qty: number | null; unit: string | null; inventory_item_name: string | null; qty_base: number | null; base_unit: string | null; issue: string | null };
type DiffRecipeRow = {
  recipe_name: string;
  menu_item_name: string | null;
  variant_name: string | null;
  yield_qty: number;
  yield_unit: string | null;
  ingredients: DiffIngredient[];
  status: 'ready' | 'exists' | 'blocked';
  issues: string[];
};
type RecipeImportDiff = { summary: { recipes: number; ready: number; exists: number; blocked: number }; recipes: DiffRecipeRow[] };
type ApplyResult = { recipes_created: number; skipped: string[] };

const STATUS_STYLE: Record<string, string> = {
  ready: 'bg-ok/15 text-ok',
  exists: 'bg-muted/15 text-muted',
  blocked: 'bg-danger/15 text-danger',
};

/**
 * The recipe-domain twin of MenuImportPanel/InventoryImportPanel — same
 * upload -> draft -> review -> approve flow, against apps/api's
 * /api/ai/recipe-import* routes. Every created recipe lands as a DRAFT
 * (never auto-activated) through the same create_recipe() RPC the manual
 * Recipes page and the AI chat use, so "Approve" here never touches a
 * live/active recipe — only "ready" rows (a resolved menu item + variant,
 * every ingredient matched to inventory with a convertible quantity, and
 * no recipe already existing for that item) can even be checked.
 */
export function RecipeImportPanel({
  slug,
  onClose,
  initialFile,
}: {
  slug: string;
  onClose: () => void;
  initialFile?: File;
}) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ranInitialFile = useRef(false);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'extracting' | 'review' | 'applying' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [draftId, setDraftId] = useState<string | null>(null);
  const [diff, setDiff] = useState<RecipeImportDiff | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function handleFile(file: File) {
    setError(null);
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.txt') && !lower.endsWith('.pdf')) {
      setError('Only CSV, plain text, or PDF files are supported right now.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFilename(file.name);
    setStage('uploading');
    const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('ai-imports').upload(path, file, { contentType: file.type || 'text/plain' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('extracting');
    try {
      const res = await fetch(`${API}/api/ai/recipe-import`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, storagePath: path, filename: file.name }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not read this document.');
        setStage('idle');
        return;
      }
      setDraftId(body.draftId);
      setDiff(body.diff);
      const initial = new Set<string>();
      (body.diff as RecipeImportDiff).recipes.forEach((row, i) => {
        if (row.status === 'ready') initial.add(String(i));
      });
      setApproved(initial);
      setStage('review');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  useEffect(() => {
    if (initialFile && !ranInitialFile.current) {
      ranInitialFile.current = true;
      handleFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(key: string) {
    setApproved((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function apply() {
    if (!draftId || approved.size === 0) return;
    setStage('applying');
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/recipe-import/apply`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, draftId, approvedItemKeys: Array.from(approved) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Applying the import failed.');
        setStage('review');
        return;
      }
      setApplyResult(body.result);
      setStage('done');
    } catch {
      setError('Network error.');
      setStage('review');
    }
  }

  async function reject() {
    if (!draftId) return onClose();
    await fetch(`${API}/api/ai/recipe-import/reject`, {
      method: 'POST',
      headers: await authHeader(),
      body: JSON.stringify({ slug, draftId }),
    }).catch(() => {});
    onClose();
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Import Recipes from File</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload a CSV, text, or PDF document listing recipes (menu item, ingredients with quantities). Every
            approved recipe is created as a <strong>draft</strong> — it never goes live until you activate it in
            Recipes. Only new recipes can be created here; a menu item that already has one is left untouched.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <button onClick={() => fileInputRef.current?.click()} className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs">
            Choose File…
          </button>
        </div>
      )}

      {(stage === 'uploading' || stage === 'extracting') && (
        <p className="text-xs text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and extracting recipes…'}</p>
      )}

      {(stage === 'review' || stage === 'applying') && diff && (
        <div className="space-y-3">
          <div className="text-xs">
            Found <strong>{diff.summary.recipes}</strong> recipe(s) —{' '}
            <span className="text-ok font-semibold">{diff.summary.ready} ready</span>,{' '}
            <span className="text-muted font-semibold">{diff.summary.exists} already exist</span>
            {diff.summary.blocked > 0 && <span className="text-danger font-semibold">, {diff.summary.blocked} blocked</span>}.
          </div>
          <p className="text-[11px] text-muted">
            Recipes are added as drafts and not linked to any dish. Link each one yourself from Menu → a product → Recipe.
          </p>
          <div className="max-h-96 overflow-y-auto space-y-2 border border-border rounded p-2 bg-surface">
            {diff.recipes.map((row, i) => {
              const key = String(i);
              return (
                <label key={i} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/40 last:border-0">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={approved.has(key)}
                    disabled={row.status !== 'ready' || stage === 'applying'}
                    onChange={() => toggle(key)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold">{row.recipe_name}</span>
                      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                    </div>
                    {(row.menu_item_name || row.yield_unit) && (
                      <div className="text-[11px] text-muted">
                        {row.menu_item_name ? `Document says it's for ${row.menu_item_name}${row.variant_name ? ` · ${row.variant_name}` : ''}` : ''}
                        {row.menu_item_name && row.yield_unit ? ' — ' : ''}
                        {row.yield_unit ? `makes ${row.yield_qty} ${row.yield_unit}` : ''}
                      </div>
                    )}
                    <div className="text-[11px] text-muted">
                      {row.ingredients.map((ing, ii) => (
                        <span key={ii} className={`mr-2 ${ing.issue ? 'text-danger' : ''}`}>
                          {ing.qty_base != null ? `${ing.qty_base}${ing.base_unit} ` : ''}
                          {ing.inventory_item_name ?? ing.name}
                          {ing.issue ? ` (${ing.issue})` : ''}
                        </span>
                      ))}
                    </div>
                    {row.status === 'blocked' && row.issues.length > 0 && (
                      <div className="text-[11px] text-danger">{row.issues.join(' · ')}</div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              onClick={apply}
              disabled={approved.size === 0 || stage === 'applying'}
              className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {stage === 'applying' ? 'Creating…' : `Create ${approved.size} Draft Recipe(s)`}
            </button>
            <button onClick={reject} disabled={stage === 'applying'} className="rounded border border-danger text-danger px-3 py-1.5 text-xs font-semibold">
              Reject All
            </button>
          </div>
        </div>
      )}

      {stage === 'done' && applyResult && (
        <div className="space-y-2 text-xs">
          <p className="text-ok font-semibold">Recipe import applied — {applyResult.recipes_created} draft recipe(s) created.</p>
          <p className="text-muted">Review and activate them from the Recipes page when ready.</p>
          {applyResult.skipped.length > 0 && <div className="text-muted">Skipped: {applyResult.skipped.join(', ')}</div>}
          <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold mt-1">
            Close
          </button>
        </div>
      )}
    </div>
  );
}
