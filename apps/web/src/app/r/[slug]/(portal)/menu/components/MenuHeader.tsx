'use client';

import { FolderPlus, Plus } from 'lucide-react';

export function MenuHeader({
  canCreate,
  onAddProduct,
  onManageCategories,
}: {
  canCreate: boolean;
  onAddProduct: () => void;
  onManageCategories: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-black">Menu</h1>
        <p className="text-muted text-xs mt-1 max-w-xl">
          Manage products, pricing, availability and customer-facing menu content — this is the
          authoritative menu every portal, order, and the Customer Menu reads from.
        </p>
      </div>
      {canCreate && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onManageCategories}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-main transition-colors"
          >
            <FolderPlus size={14} /> Add Category
          </button>
          <button
            onClick={onAddProduct}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-fg px-3.5 py-2 text-xs font-bold hover:opacity-90 transition-opacity"
          >
            <Plus size={14} /> Add Product
          </button>
        </div>
      )}
    </div>
  );
}
