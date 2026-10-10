// The branch a person is working in (multi-branch, tenant migrations 0098+).
//
// Stored in a cookie scoped to the restaurant's own pages, and sent to the
// restaurant's database with every request as the `x-branch-ids` header. It
// is a VIEW choice only: the database intersects it with the branches the
// login may use, so a forged value can never widen access.

export const BRANCH_COOKIE = 'ar_branch';
export const ALL_BRANCHES = 'all';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cookie value → header value ("all", missing or malformed → no header). */
export function branchHeaderFrom(cookieValue: string | null | undefined): string | null {
  const v = (cookieValue ?? '').trim();
  return UUID.test(v) ? v : null;
}

export type BranchRow = {
  id: string;
  code: string;
  name: string;
  city: string | null;
  status: 'active' | 'inactive' | 'archived';
  is_default: boolean;
  timezone: string | null;
  currency_code: string | null;
};
