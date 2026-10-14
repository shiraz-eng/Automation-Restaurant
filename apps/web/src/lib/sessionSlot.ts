/**
 * Session slots: several logins of one restaurant open side by side in one browser.
 *
 * A browser keeps one Supabase session per cookie path, and every restaurant page lives
 * under /r/<slug>, so before slots the owner's panel, each portal and each branch login
 * all shared one sign-in — opening the Checkout portal threw you back to the main panel.
 * A slot is a suffix on the restaurant's address:
 *
 *   /r/bbq-tonight/…                          the main panel (owner, staff)
 *   /r/bbq-tonight~checkout/portal/checkout   the Checkout portal, signed in on its own
 *   /r/bbq-tonight~dha/login                  a DHA branch login, signed in on its own
 *
 * The cookie path /r/bbq-tonight does not cover /r/bbq-tonight~dha (cookie paths match
 * only at a "/"), so each slot keeps its own session. The restaurant itself is always
 * the part before "~"; a slot never changes which restaurant, or what a login may do.
 */
export const SLOT_SEP = '~';
const SLOT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function decoded(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** The restaurant's slug, without any session slot. */
export function baseSlug(slug: string): string {
  return decoded(slug).split(SLOT_SEP)[0];
}

/** The session slot in a /r/<slug> segment, or null for the main panel. */
export function slotOf(slug: string): string | null {
  const s = decoded(slug).split(SLOT_SEP)[1]?.toLowerCase();
  return s && SLOT_RE.test(s) ? s : null;
}

/** The /r/<segment> for a restaurant and a slot (lower-cased; invalid slots fall back to main). */
export function slotSlug(base: string, slot: string): string {
  const s = slot.toLowerCase();
  return SLOT_RE.test(s) ? `${base}${SLOT_SEP}${s}` : base;
}
