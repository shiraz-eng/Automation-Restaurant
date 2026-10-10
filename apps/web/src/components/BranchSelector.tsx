'use client';

import { ALL_BRANCHES, BRANCH_COOKIE, type BranchRow } from '@/lib/branchScope';

/**
 * "All branches" or one branch. Remembered per restaurant (a cookie on its
 * own /r/<slug> pages) and applied with a full reload, so every screen and the
 * one database client start over in the new branch. A view choice only: the
 * database decides which branches this login may see.
 */
export function BranchSelector({
  slug,
  branches,
  selected,
  allowAll,
}: {
  slug: string;
  branches: BranchRow[];
  selected: string | null;
  allowAll: boolean;
}) {
  if (branches.length < 2) return null;
  function pick(value: string) {
    document.cookie = `${BRANCH_COOKIE}=${encodeURIComponent(value)}; path=/r/${slug}; max-age=31536000; samesite=lax`;
    window.location.reload();
  }
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Branch</span>
      <select
        id="branch-selector"
        value={selected ?? ALL_BRANCHES}
        onChange={(e) => pick(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-main px-2.5 py-1.5 text-xs font-semibold text-body"
      >
        {allowAll && <option value={ALL_BRANCHES}>All branches</option>}
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.city ? ` · ${b.city}` : ''}
            {b.status !== 'active' ? ' (inactive)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
