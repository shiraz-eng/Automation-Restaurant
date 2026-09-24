'use client';

import { useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { MenuImportPanel } from './MenuImportPanel';
import { InventoryImportPanel } from './InventoryImportPanel';
import { RecipeImportPanel } from './RecipeImportPanel';
import { TableImportPanel } from './TableImportPanel';
import { SupplierImportPanel } from './SupplierImportPanel';
import { SupplierPriceImportPanel } from './SupplierPriceImportPanel';
import { PoImportPanel } from './PoImportPanel';
import { StaffImportPanel } from './StaffImportPanel';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const MAX_BYTES = 10 * 1024 * 1024;

type Category = 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers' | 'supplier_prices' | 'purchase_orders' | 'staff' | 'unknown';

const LABELS: Record<Category, string> = {
  menu: 'Menu',
  inventory: 'Inventory',
  recipes: 'Recipes',
  tables: 'Tables',
  suppliers: 'Suppliers',
  supplier_prices: 'Supplier Prices',
  purchase_orders: 'Purchase Orders',
  staff: 'Staff',
  unknown: "I'm not sure",
};

/**
 * The single upload entry point (spec: "one AI Operating System, not a
 * separate Menu AI / Inventory AI / ..."). Upload anything once; the
 * model classifies which of the eight import domains it looks like (pure
 * text classification — this step never writes anything), you confirm or
 * override the guess, and control then hands off to that domain's own
 * import panel — same upload, same extraction, same diff, same approval a
 * domain-specific flow would give you. Classification only decides which
 * panel opens for you.
 */
export function SmartImportPanel({
  slug,
  onClose,
  available,
}: {
  slug: string;
  onClose: () => void;
  /** Which domains this caller is actually allowed to use — an override
   *  can only offer (and classification can only route to) one of these. */
  available: Category[];
}) {
  const supabase = usePortalSupabase();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<'idle' | 'uploading' | 'classifying' | 'confirm' | 'routed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState('');
  const [category, setCategory] = useState<Category | null>(null);
  const [reasoning, setReasoning] = useState('');
  const [chosen, setChosen] = useState<Category | null>(null);

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function handleFile(f: File) {
    setError(null);
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.csv') && !lower.endsWith('.txt') && !lower.endsWith('.pdf')) {
      setError('Only CSV, plain text, or PDF files are supported right now.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('File must be under 10 MB.');
      return;
    }
    setFile(f);
    setFilename(f.name);
    setStage('uploading');
    // A separate copy uploaded to ai-imports purely so the classifier can
    // read it server-side — the domain panel this hands off to does its
    // OWN full upload afterward (to whichever bucket that domain uses),
    // so this copy is never reused for the real import itself.
    const path = `${Date.now()}-classify-${f.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
    const { error: upErr } = await supabase.storage.from('ai-imports').upload(path, f, { contentType: f.type || 'text/plain' });
    if (upErr) {
      setError(upErr.message);
      setStage('idle');
      return;
    }
    setStage('classifying');
    try {
      const res = await fetch(`${API}/api/ai/classify-import`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, storagePath: path, filename: f.name }),
      });
      // A timeout or crash on the host comes back as an HTML/plain error
      // page, not JSON — report the status instead of a vague network error.
      const body = await res.json().catch(() => ({
        message:
          res.status === 504
            ? 'Reading the document took too long. Try a smaller file or a CSV export.'
            : `The import service returned an error (HTTP ${res.status}). Please try again.`,
      }));
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Could not read this document.');
        setStage('idle');
        return;
      }
      const cat: Category = available.includes(body.category) ? body.category : 'unknown';
      setCategory(cat);
      setReasoning(body.reasoning ?? '');
      setChosen(cat !== 'unknown' ? cat : null);
      setStage('confirm');
    } catch {
      setError('Network error.');
      setStage('idle');
    }
  }

  function proceed() {
    if (!chosen) return;
    setStage('routed');
  }

  if (stage === 'routed' && chosen && file) {
    const props = { slug, onClose, initialFile: file };
    switch (chosen) {
      case 'menu':
        return <MenuImportPanel {...props} />;
      case 'inventory':
        return <InventoryImportPanel {...props} />;
      case 'recipes':
        return <RecipeImportPanel {...props} />;
      case 'tables':
        return <TableImportPanel {...props} />;
      case 'suppliers':
        return <SupplierImportPanel {...props} />;
      case 'supplier_prices':
        return <SupplierPriceImportPanel {...props} />;
      case 'purchase_orders':
        return <PoImportPanel {...props} />;
      case 'staff':
        return <StaffImportPanel {...props} />;
    }
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-sm">Smart Import</h2>
        <button onClick={onClose} className="text-muted text-xs">
          ✕
        </button>
      </div>

      {error && <div className="rounded border border-danger/40 bg-danger/10 text-danger p-2.5 text-xs">{error}</div>}

      {stage === 'idle' && (
        <div>
          <p className="text-xs text-muted mb-2">
            Upload any document — a menu, an ingredient list, a recipe sheet, a supplier price list, an order
            request, a staff roster — and the assistant figures out which kind it is. Nothing is created until you
            review and approve the changes in the next step.
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

      {(stage === 'uploading' || stage === 'classifying') && (
        <p className="text-xs text-muted">{stage === 'uploading' ? `Uploading ${filename}…` : 'Reading the document and figuring out what it is…'}</p>
      )}

      {stage === 'confirm' && category && (
        <div className="space-y-3">
          <div className="text-xs">
            {category === 'unknown' ? (
              <span className="text-danger font-semibold">Couldn&apos;t confidently tell what kind of document this is.</span>
            ) : (
              <>
                This looks like: <span className="font-bold text-primary">{LABELS[category]}</span>
              </>
            )}
            {reasoning && <div className="text-muted mt-1">{reasoning}</div>}
          </div>
          <div>
            <label className="text-xs text-muted block mb-1">Import as:</label>
            <select
              value={chosen ?? ''}
              onChange={(e) => setChosen((e.target.value || null) as Category | null)}
              className="w-full rounded border border-border bg-surface p-2 text-xs"
            >
              <option value="">— choose one —</option>
              {available.map((c) => (
                <option key={c} value={c}>
                  {LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={proceed}
              disabled={!chosen}
              className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Continue
            </button>
            <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-xs font-semibold">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
