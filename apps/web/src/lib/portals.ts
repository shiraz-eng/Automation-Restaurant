/**
 * Which portal a staff role lands in. A waiter never sees the owner dashboard.
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

/**
 * Standalone-portal home for a role. Roles that still have a dedicated legacy
 * surface return its path; everyone else (owner, manager, cashier since P4, and
 * any custom role) resolves to the Operations Portal root. The Operations layout
 * uses this to decide who to bounce out.
 */
export function roleHome(role: string, slug: string): string {
  switch (role) {
    case 'chef':
      return `/r/${slug}/kitchen`;
    case 'waiter':
    case 'host':
      return `/r/${slug}/floor`;
    case 'accountant':
      return `/r/${slug}/finance`;
    case 'delivery':
      return `/r/${slug}/deliveries`;
    default:
      return `/r/${slug}`; // owner, manager, cashier (P4), hr (P6), custom roles
  }
}

/** Preferred landing path after login, including Operations sub-routes. */
export function roleLanding(role: string, slug: string): string {
  if (role === 'cashier') return `/r/${slug}/checkout`;
  return roleHome(role, slug);
}

export function isManagement(role: string): boolean {
  return role === 'owner' || role === 'manager';
}

/** Roles allowed into the kitchen portal. */
export function canSeeKitchen(role: string): boolean {
  return role === 'chef' || isManagement(role);
}

/** Roles allowed into the cashier / register portal. */
export function canSeeRegister(role: string): boolean {
  return role === 'cashier' || isManagement(role);
}

/** Roles allowed into the waiter / floor portal. */
export function canSeeFloor(role: string): boolean {
  return role === 'waiter' || role === 'host' || isManagement(role);
}

export function canSeeFinance(role: string): boolean {
  return role === 'accountant' || role === 'owner';
}

export function canSeeTeam(role: string): boolean {
  return role === 'hr' || isManagement(role);
}

export function canSeeDeliveries(role: string): boolean {
  return role === 'delivery' || isManagement(role);
}
