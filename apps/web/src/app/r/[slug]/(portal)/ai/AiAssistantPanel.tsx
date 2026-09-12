'use client';

import { useState } from 'react';
import { MenuImportPanel } from './MenuImportPanel';
import { InventoryImportPanel } from './InventoryImportPanel';
import { RecipeImportPanel } from './RecipeImportPanel';
import { TableImportPanel } from './TableImportPanel';
import { SupplierImportPanel } from './SupplierImportPanel';

type ImportKind = 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. Five domains are wired to real backends here,
 * all built on the same shared document-to-draft engine
 * (apps/api/src/lib/aiDocumentEngine.ts) rather than separate one-off
 * implementations — proving the "AI should not be designed as menu-import
 * AI" pattern generalizes. Other suggested actions from the spec's UI
 * mockup (bulk price updates, PO creation from a document, staff import)
 * are deliberately NOT rendered here rather than shipped as placeholder
 * buttons that do nothing.
 */
export function AiAssistantPanel({
  slug,
  canImportMenu,
  canImportInventory,
  canImportRecipes,
  canImportTables,
  canImportSuppliers,
}: {
  slug: string;
  canImportMenu: boolean;
  canImportInventory: boolean;
  canImportRecipes: boolean;
  canImportTables: boolean;
  canImportSuppliers: boolean;
}) {
  const [open, setOpen] = useState<ImportKind | null>(null);

  const options: { kind: ImportKind; enabled: boolean; icon: string; title: string; desc: string }[] = [
    { kind: 'menu', enabled: canImportMenu, icon: '📄', title: 'Import Menu from File', desc: 'Upload a menu PDF — review and approve the changes before anything goes live.' },
    { kind: 'inventory', enabled: canImportInventory, icon: '📦', title: 'Import Inventory from File', desc: 'Upload a CSV, text, or PDF ingredient list — review and approve before anything is added or changed.' },
    { kind: 'recipes', enabled: canImportRecipes, icon: '📋', title: 'Import Recipes from File', desc: 'Upload a document listing recipes and ingredients — creates draft recipes for review, never live.' },
    { kind: 'tables', enabled: canImportTables, icon: '🪑', title: 'Import Tables from File', desc: 'Upload a list of tables and seat counts — only creates new tables.' },
    { kind: 'suppliers', enabled: canImportSuppliers, icon: '🚚', title: 'Import Suppliers from File', desc: 'Upload a supplier directory — only creates new suppliers.' },
  ];

  if (!options.some((o) => o.enabled)) return null;

  if (open === 'menu') return <MenuImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'inventory') return <InventoryImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'recipes') return <RecipeImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'tables') return <TableImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'suppliers') return <SupplierImportPanel slug={slug} onClose={() => setOpen(null)} />;

  return (
    <div className="space-y-2">
      {options
        .filter((o) => o.enabled)
        .map((o) => (
          <button
            key={o.kind}
            onClick={() => setOpen(o.kind)}
            className="w-full text-left rounded-lg border border-border bg-surface hover:border-primary/50 p-3 text-xs flex items-center gap-2"
          >
            <span className="text-base">{o.icon}</span>
            <span>
              <span className="font-bold">{o.title}</span>
              <span className="text-muted block">{o.desc}</span>
            </span>
          </button>
        ))}
    </div>
  );
}
