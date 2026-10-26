/**
 * The accessibility no-flash script, kept out of the 'use client' module so the
 * root layout (a server component) can inline it. Mirrors applyA11y() in a11y.ts.
 */
export const A11Y_STORAGE_KEY = 'ar-a11y';

/** Runs in <head> before the page paints (see app/layout.tsx). */
export const A11Y_NO_FLASH = `
try {
  var a = JSON.parse(localStorage.getItem('${A11Y_STORAGE_KEY}') || '{}');
  var e = document.documentElement;
  if ([112,125,150].indexOf(a.text) >= 0) e.setAttribute('data-a11y-text', String(a.text));
  if (a.contrast === 'high') e.setAttribute('data-a11y-contrast', 'high');
  if (a.motion === 'reduce') e.setAttribute('data-a11y-motion', 'reduce');
  if (a.underlineLinks === true) e.setAttribute('data-a11y-links', 'underline');
  if (a.spacing === true) e.setAttribute('data-a11y-spacing', 'wide');
  if (a.largeTargets === true) e.setAttribute('data-a11y-targets', 'large');
} catch (x) {}
`;
