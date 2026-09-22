'use client';

import { useState } from 'react';
import { SmartImportPanel } from './SmartImportPanel';

// Backend classification categories — same domains, snake_case to match apps/api/src/lib/importClassifier.ts.
type Category = 'menu' | 'inventory' | 'recipes' | 'tables' | 'suppliers' | 'supplier_prices' | 'purchase_orders' | 'staff';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. Smart Import is the ONE front door (spec: "one
 * AI Operating System, not a separate Menu AI / Inventory AI / ..."):
 * upload anything — a menu, an ingredient list, a recipe sheet, a supplier
 * price list, an order request, a staff roster — and the assistant
 * classifies which of the eight domains it is, then hands off to that
 * exact domain's real import engine (apps/api/src/lib/aiDocumentEngine.ts)
 * internally. No separate per-domain buttons here anymore — a caller who
 * already knows what they have still just uploads it and confirms (or
 * overrides) the guess in Smart Import's own next step, rather than
 * hunting for the matching button first.
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
  const [open, setOpen] = useState(false);

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

  if (available.length === 0) return null;

  if (open) return <SmartImportPanel slug={slug} onClose={() => setOpen(false)} available={available} />;

  return (
    <button
      onClick={() => setOpen(true)}
      className="w-full text-left rounded-lg border-2 border-primary/60 bg-primary/10 hover:border-primary p-3 text-xs flex items-center gap-2"
    >
      <span className="text-base">✨</span>
      <span>
        <span className="font-bold">Smart Import</span>
        <span className="text-muted block">Upload any document — the assistant figures out which kind it is and routes it for you.</span>
      </span>
    </button>
  );
}
