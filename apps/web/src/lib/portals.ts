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

/** Home path for a role, within a restaurant. */
export function roleHome(role: string, slug: string): string {
  switch (role) {
    case 'chef':
      return `/r/${slug}/kitchen`;
    case 'cashier':
      return `/r/${slug}/register`;
    case 'waiter':
    case 'host':
      return `/r/${slug}/floor`;
    case 'accountant':
      return `/r/${slug}/finance`;
    case 'hr':
      return `/r/${slug}/team`;
    case 'delivery':
      return `/r/${slug}/deliveries`;
    default:
      return `/r/${slug}`; // owner / manager → management portal
  }
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
