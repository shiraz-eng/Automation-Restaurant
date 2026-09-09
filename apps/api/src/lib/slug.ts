/**
 * URL-safe slug from a restaurant name. Collision resolution (appending a random
 * suffix) happens in the `provision_tenant` DB function, which owns the unique
 * constraint — do not try to pre-check uniqueness here (it races).
 */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '') // strip diacritics left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return slug || 'restaurant';
}
