import { cache } from 'react';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BRANCH_COOKIE, branchHeaderFrom, type BranchRow } from './branchScope';

export type BranchContext = {
  /** Branches this login may use (my_branches()); empty before migration 0098. */
  branches: BranchRow[];
  /** The branch being worked in, or null for "All branches". */
  selectedId: string | null;
  selected: BranchRow | null;
  /** More than one branch to choose from. */
  multi: boolean;
};

/**
 * The login's branches and the one it's working in, once per request. A
 * cookie naming a branch the login can't use is ignored (the database would
 * ignore it too); a login with a single branch is always in that branch.
 */
export const loadBranchContext = cache(async (client: SupabaseClient): Promise<BranchContext> => {
  const { data, error } = await client.rpc('my_branches');
  const branches = error ? [] : ((data ?? []) as BranchRow[]);
  const cookieId = branchHeaderFrom((await cookies()).get(BRANCH_COOKIE)?.value);
  let selected = branches.find((b) => b.id === cookieId) ?? null;
  if (!selected && branches.length === 1) selected = branches[0];
  return { branches, selectedId: selected?.id ?? null, selected, multi: branches.length > 1 };
});
