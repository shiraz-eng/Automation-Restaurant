'use client';

import { useState } from 'react';
import { MenuImportPanel } from './MenuImportPanel';
import { InventoryImportPanel } from './InventoryImportPanel';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. "Import Menu from File" and "Import Inventory
 * from File" are both wired to real backends — two domains built on the
 * same shared document-to-draft engine (apps/api/src/lib/aiDocumentEngine.ts)
 * rather than separate one-off implementations. Other suggested actions
 * from the spec's UI mockup (add supplier, create recipe, create deal,
 * generate report) are deliberately NOT rendered here rather than shipped
 * as placeholder buttons that do nothing.
 */
export function AiAssistantPanel({
  slug,
  canImportMenu,
  canImportInventory,
}: {
  slug: string;
  canImportMenu: boolean;
  canImportInventory: boolean;
}) {
  const [open, setOpen] = useState<'menu' | 'inventory' | null>(null);

  if (!canImportMenu && !canImportInventory) return null;

  if (open === 'menu') return <MenuImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'inventory') return <InventoryImportPanel slug={slug} onClose={() => setOpen(null)} />;

  return (
    <div className="space-y-2">
      {canImportMenu && (
        <button
          onClick={() => setOpen('menu')}
          className="w-full text-left rounded-lg border border-border bg-surface hover:border-primary/50 p-3 text-xs flex items-center gap-2"
        >
          <span className="text-base">📄</span>
          <span>
            <span className="font-bold">Import Menu from File</span>
            <span className="text-muted block">Upload a menu PDF — review and approve the changes before anything goes live.</span>
          </span>
        </button>
      )}
      {canImportInventory && (
        <button
          onClick={() => setOpen('inventory')}
          className="w-full text-left rounded-lg border border-border bg-surface hover:border-primary/50 p-3 text-xs flex items-center gap-2"
        >
          <span className="text-base">📦</span>
          <span>
            <span className="font-bold">Import Inventory from File</span>
            <span className="text-muted block">Upload a CSV, text, or PDF ingredient list — review and approve before anything is added or changed.</span>
          </span>
        </button>
      )}
    </div>
  );
}
