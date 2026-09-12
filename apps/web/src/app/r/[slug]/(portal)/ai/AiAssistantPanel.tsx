'use client';

import { useState } from 'react';
import { MenuImportPanel } from './MenuImportPanel';
import { InventoryImportPanel } from './InventoryImportPanel';
import { RecipeImportPanel } from './RecipeImportPanel';
import { TableImportPanel } from './TableImportPanel';
import { SupplierImportPanel } from './SupplierImportPanel';
import { SupplierPriceImportPanel } from './SupplierPriceImportPanel';
import { PoImportPanel } from './PoImportPanel';
import { StaffImportPanel } from './StaffImportPanel';

type ImportKind = 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers' | 'supplierPrices' | 'purchaseOrders' | 'staff';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. Eight domains are wired to real backends here,
 * all built on the same shared document-to-draft engine
 * (apps/api/src/lib/aiDocumentEngine.ts) — proving the "AI should not be
 * designed as menu-import AI" pattern generalizes across the whole
 * restaurant, not just documents. A generic cross-domain planning flow
 * (one upload chaining menu -> inventory -> recipes -> suppliers) is
 * deliberately NOT built — each domain here stays its own reviewed,
 * approved step.
 */
export function AiAssistantPanel({
  slug,
  canImportMenu,
  canImportInventory,
  canImportRecipes,
  canImportTables,
  canImportSuppliers,
  canImportSupplierPrices,
  canImportPurchaseOrders,
  canImportStaff,
}: {
  slug: string;
  canImportMenu: boolean;
  canImportInventory: boolean;
  canImportRecipes: boolean;
  canImportTables: boolean;
  canImportSuppliers: boolean;
  canImportSupplierPrices: boolean;
  canImportPurchaseOrders: boolean;
  canImportStaff: boolean;
}) {
  const [open, setOpen] = useState<ImportKind | null>(null);

  const options: { kind: ImportKind; enabled: boolean; icon: string; title: string; desc: string }[] = [
    { kind: 'menu', enabled: canImportMenu, icon: '📄', title: 'Import Menu from File', desc: 'Upload a menu PDF — review and approve the changes before anything goes live.' },
    { kind: 'inventory', enabled: canImportInventory, icon: '📦', title: 'Import Inventory from File', desc: 'Upload a CSV, text, or PDF ingredient list — review and approve before anything is added or changed.' },
    { kind: 'recipes', enabled: canImportRecipes, icon: '📋', title: 'Import Recipes from File', desc: 'Upload a document listing recipes and ingredients — creates draft recipes for review, never live.' },
    { kind: 'tables', enabled: canImportTables, icon: '🪑', title: 'Import Tables from File', desc: 'Upload a list of tables and seat counts — only creates new tables.' },
    { kind: 'suppliers', enabled: canImportSuppliers, icon: '🚚', title: 'Import Suppliers from File', desc: 'Upload a supplier directory — only creates new suppliers.' },
    { kind: 'supplierPrices', enabled: canImportSupplierPrices, icon: '💲', title: 'Import Supplier Prices from File', desc: 'Upload a supplier price list — matches existing suppliers and items, review before applying.' },
    { kind: 'purchaseOrders', enabled: canImportPurchaseOrders, icon: '🧾', title: 'Import Purchase Orders from File', desc: 'Upload an order request — creates draft POs priced from each supplier\'s own catalog.' },
    { kind: 'staff', enabled: canImportStaff, icon: '🧑‍🍳', title: 'Import Staff from File', desc: 'Upload a staff roster — creates real logins only for rows you approve.' },
  ];

  if (!options.some((o) => o.enabled)) return null;

  if (open === 'menu') return <MenuImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'inventory') return <InventoryImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'recipes') return <RecipeImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'tables') return <TableImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'suppliers') return <SupplierImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'supplierPrices') return <SupplierPriceImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'purchaseOrders') return <PoImportPanel slug={slug} onClose={() => setOpen(null)} />;
  if (open === 'staff') return <StaffImportPanel slug={slug} onClose={() => setOpen(null)} />;

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
