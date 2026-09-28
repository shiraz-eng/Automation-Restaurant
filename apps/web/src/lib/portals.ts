import { can } from '@/lib/permissions';

/**
 * Staff roles. Every staff login (whatever its role) uses the one main
 * portal at /r/{slug}; what it sees there is decided by its permissions, not
 * by the role name. Custom portals (Portal Management) are the only way to
 * give a station its own screen.
 */

export type StaffRole =
  | 'owner'
  | 'manager'
  | 'cashier'
  | 'chef'
  | 'waiter'
  | 'host'
  | 'hr'
  | 'accountant'
  | 'delivery';

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  chef: 'Kitchen',
  waiter: 'Waiter',
  host: 'Host',
  hr: 'HR',
  accountant: 'Accountant',
  delivery: 'Delivery',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role as StaffRole] ?? role;
}

/**
 * Where a staff member without the business dashboard (analytics.view)
 * starts in the main portal: the first page their permissions open, most
 * hands-on first. [what the job is about, the key that page's own gate
 * checks, page] — both must be held, so this never points at a page that
 * bounces back to the dashboard (which would loop).
 */
const START_PAGES: [string, string, string][] = [
  ['kitchen.update_status', 'kitchen.view', 'kds'],
  ['payments.accept', 'payments.view', 'checkout'],
  ['finance.view', 'finance.view', 'expenses'],
  ['staff.view', 'staff.view', 'staff'],
  ['tables.update', 'tables.view', 'tables'],
  ['orders.view', 'orders.view', 'orders'],
  ['kitchen.view', 'kitchen.view', 'kds'],
  ['menu.view', 'menu.view', 'menu'],
];

export function staffStartPath(perms: string[], role: string, slug: string): string {
  const hit = START_PAGES.find(([job, gate]) => can(perms, role, job) && can(perms, role, gate));
  return hit ? `/r/${slug}/${hit[2]}` : `/r/${slug}/guide`;
}
