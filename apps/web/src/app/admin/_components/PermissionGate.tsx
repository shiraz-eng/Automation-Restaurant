import { canAdmin } from '@/lib/adminPermissions';

/** Conditional-render helper for hiding a control the caller lacks. UI
 *  convenience only — the server-side requireSuperAdminPerm/RLS check is
 *  the real boundary, this never substitutes for it. */
export function PermissionGate({
  perms,
  role,
  need,
  children,
  fallback = null,
}: {
  perms: string[];
  role: string;
  need: string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  return canAdmin(perms, role, need) ? <>{children}</> : <>{fallback}</>;
}
