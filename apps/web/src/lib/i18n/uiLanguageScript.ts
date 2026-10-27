/**
 * The restaurant portal's screen language, chosen per device. Kept out of the
 * 'use client' module so the root layout (a server component) can inline the
 * no-flash script. Only restaurant pages (/r/…) are translated; the website
 * and the platform admin stay in English.
 */
export const UI_LANG_STORAGE_KEY = 'ar-ui-lang';
export const RTL_UI_LANGUAGES = ['ur', 'ar', 'fa', 'ps', 'sd', 'he'];

/**
 * Runs in <head> before the page paints: sets <html lang/dir> and hides the
 * page until the translator has done its first pass (with a safety timeout,
 * so a failed script never leaves the page blank).
 */
export const UI_LANG_NO_FLASH = `
try {
  var l = localStorage.getItem('${UI_LANG_STORAGE_KEY}');
  if (l && l !== 'en' && /^\\/r\\//.test(location.pathname)) {
    var h = document.documentElement;
    h.setAttribute('lang', l);
    if (${JSON.stringify(RTL_UI_LANGUAGES)}.indexOf(l) >= 0) h.setAttribute('dir', 'rtl');
    h.setAttribute('data-ui-pending', '');
    setTimeout(function () { h.removeAttribute('data-ui-pending'); }, 1500);
  }
} catch (e) {}
`;
