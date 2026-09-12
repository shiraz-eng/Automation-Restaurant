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
import { SmartImportPanel } from './SmartImportPanel';

type ImportKind = 'smart' | 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers' | 'supplierPrices' | 'purchaseOrders' | 'staff';
// Backend classification categories — same domains, snake_case to match apps/api/src/lib/importClassifier.ts.
type Category = 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers' | 'supplier_prices' | 'purchase_orders' | 'staff';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. Eight domains are wired to real backends here,
 * all built on the same shared document-to-draft engine
 * (apps/api/src/lib/aiDocumentEngine.ts). "Smart Import" is the unified
 * front door the spec's "one AI Operating System" vision asks for: upload
 * anything and the model figures out which domain it is, then hands off
 * to the exact same panel picking it manually would open — the eight
 * explicit buttons stay too, for anyone who already knows what they have.
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

  const available: Category[] = [
    canImportMenu && 'menu',
    canImportInventory && 'inventory',
    canImportRecipes && 'recipes',
    canImportTables && 'tables',
    canImportSuppliers && 'suppliers',
    canImportSupplierPrices && 'supplier_prices',
    canImportPurchaseOrders && 'purchase_orders',
    canImportStaff && 'staff',
  ].filter((c): c is Category => c !== false);

  if (open === 'smart') return <SmartImportPanel slug={slug} onClose={() => setOpen(null)} available={available} />;
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
      <button
        onClick={() => setOpen('smart')}
        className="w-full text-left rounded-lg border-2 border-primary/60 bg-primary/10 hover:border-primary p-3 text-xs flex items-center gap-2"
      >
        <span className="text-base">✨</span>
        <span>
          <span className="font-bold">Smart Import</span>
          <span className="text-muted block">Upload any document — the assistant figures out which kind it is and routes it for you.</span>
        </span>
      </button>
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
