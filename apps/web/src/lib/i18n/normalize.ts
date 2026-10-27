/**
 * How screen text becomes a dictionary key: whitespace collapsed, and every
 * number replaced by a numbered placeholder, so "3 of 20 items" and
 * "4 of 21 items" share the key "{0} of {1} items". The dictionary builder
 * (scratch tooling) and the page translator must use exactly this.
 */
const NUM = /\d+(?:[.,:]\d+)*/g;

export function normalizeUiText(text: string): { key: string; nums: string[] } {
  const nums: string[] = [];
  const key = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(NUM, (m) => {
      nums.push(m);
      return `{${nums.length - 1}}`;
    });
  return { key, nums };
}

export function fillUiText(template: string, nums: string[]): string {
  return template.replace(/\{(\d+)\}/g, (m, i: string) => nums[Number(i)] ?? m);
}

/** Text worth translating: real words, not an email, a link, a code or a number. */
export function isTranslatable(key: string): boolean {
  if (key.length > 400 || !/[A-Za-z]{2,}/.test(key)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(key) || /^(https?:\/\/|www\.)/i.test(key)) return false;
  // Slugs, ids, file names and other lower-case codes.
  if (/^[a-z0-9_.\-/#:]+$/.test(key)) return false;
  return true;
}
