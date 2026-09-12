'use client';

import { useState } from 'react';
import { MenuImportPanel } from './MenuImportPanel';

/**
 * Entry point for AI-driven management actions that don't fit the chat's
 * single ask/answer shape. Only "Import Menu from File" is wired to a real
 * backend today — the other suggested actions from the spec's UI mockup
 * (import inventory, add supplier, create recipe, create deal, generate
 * report) are deliberately NOT rendered here rather than shipped as
 * placeholder buttons that do nothing.
 */
export function AiAssistantPanel({ slug, canImportMenu }: { slug: string; canImportMenu: boolean }) {
  const [open, setOpen] = useState(false);

  if (!canImportMenu) return null;

  if (open) return <MenuImportPanel slug={slug} onClose={() => setOpen(false)} />;

  return (
    <button
      onClick={() => setOpen(true)}
      className="w-full text-left rounded-lg border border-border bg-surface hover:border-primary/50 p-3 text-xs flex items-center gap-2"
    >
      <span className="text-base">📄</span>
      <span>
        <span className="font-bold">Import Menu from File</span>
        <span className="text-muted block">Upload a menu PDF — review and approve the changes before anything goes live.</span>
      </span>
    </button>
  );
}
