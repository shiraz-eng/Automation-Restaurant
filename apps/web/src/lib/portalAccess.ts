/**
 * Who may open a station portal (/r/[slug]/portal/[portalKey]): the portal's
 * own login, or a staff login (owner/manager) previewing it. A station login
 * never opens another station's portal — not even one granted Portal
 * Management (portals.view), which manages portals from its own page.
 */
export type PortalLoginMeta = { kind?: string; portal_id?: string; permissions?: string[] };

export function portalAccess(meta: PortalLoginMeta, portal: { id: string; status: string; force_pw_change?: boolean | null }) {
  const perms = meta.permissions ?? [];
  const isThisPortal = meta.kind === 'portal' && meta.portal_id === portal.id;
  const isPreviewer = meta.kind !== 'portal' && (perms.includes('*') || perms.includes('portals.view'));
  const allowed = (isThisPortal || isPreviewer) && (portal.status !== 'disabled' || isPreviewer);
  return { allowed, isThisPortal, isPreviewer, mustSetPassword: allowed && isThisPortal && !!portal.force_pw_change };
}
