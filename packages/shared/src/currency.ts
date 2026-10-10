/**
 * The currencies a restaurant can run in, shared by the API (AI answers,
 * Excel, emails) and the web app (every screen, receipt and PDF).
 *
 * Every amount is stored as an integer number of hundredths ("cents"), so
 * only currencies with two decimal places are offered — a 0-decimal (JPY)
 * or 3-decimal (KWD, BHD, OMR) currency would read every stored amount
 * wrongly. Changing a restaurant's currency changes how amounts are shown;
 * it never converts them.
 */
export type CurrencyInfo = {
  code: string;
  name: string;
  /** Locale used to format it, chosen so the symbol reads naturally (en-PK → "Rs 1,250"). */
  locale: string;
};

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'PKR', name: 'Pakistani rupee', locale: 'en-PK' },
  { code: 'USD', name: 'US dollar', locale: 'en-US' },
  { code: 'EUR', name: 'Euro', locale: 'en-IE' },
  { code: 'GBP', name: 'British pound', locale: 'en-GB' },
  { code: 'AED', name: 'UAE dirham', locale: 'en-AE' },
  { code: 'SAR', name: 'Saudi riyal', locale: 'en-SA' },
  { code: 'QAR', name: 'Qatari riyal', locale: 'en-QA' },
  { code: 'INR', name: 'Indian rupee', locale: 'en-IN' },
  { code: 'BDT', name: 'Bangladeshi taka', locale: 'en-BD' },
  { code: 'LKR', name: 'Sri Lankan rupee', locale: 'en-LK' },
  { code: 'NPR', name: 'Nepalese rupee', locale: 'en-NP' },
  { code: 'AFN', name: 'Afghan afghani', locale: 'en-AF' },
  { code: 'MYR', name: 'Malaysian ringgit', locale: 'en-MY' },
  { code: 'SGD', name: 'Singapore dollar', locale: 'en-SG' },
  { code: 'THB', name: 'Thai baht', locale: 'en-TH' },
  { code: 'TRY', name: 'Turkish lira', locale: 'en-TR' },
  { code: 'EGP', name: 'Egyptian pound', locale: 'en-EG' },
  { code: 'NGN', name: 'Nigerian naira', locale: 'en-NG' },
  { code: 'KES', name: 'Kenyan shilling', locale: 'en-KE' },
  { code: 'ZAR', name: 'South African rand', locale: 'en-ZA' },
  { code: 'CAD', name: 'Canadian dollar', locale: 'en-CA' },
  { code: 'AUD', name: 'Australian dollar', locale: 'en-AU' },
  { code: 'NZD', name: 'New Zealand dollar', locale: 'en-NZ' },
  { code: 'CNY', name: 'Chinese yuan', locale: 'en-CN' },
];

export const DEFAULT_CURRENCY = 'USD';

export function currencyInfo(code: string | null | undefined): CurrencyInfo {
  const c = (code ?? '').toUpperCase();
  return CURRENCIES.find((x) => x.code === c) ?? CURRENCIES.find((x) => x.code === DEFAULT_CURRENCY)!;
}

/** "Rs 1,250.50" / "$1,250.50" / "AED 1,250.50" — integer hundredths in, display text out.
 *  Always two decimals: some locales (en-PK) would otherwise round rupees to whole numbers. */
export function formatMoney(cents: number, code?: string | null): string {
  const info = currencyInfo(code);
  try {
    return new Intl.NumberFormat(info.locale, { style: 'currency', currency: info.code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
  } catch {
    return `${info.code} ${((Number(cents) || 0) / 100).toFixed(2)}`;
  }
}

/** The currency's symbol as it appears in formatMoney (e.g. "Rs", "$", "AED"). */
export function currencySymbol(code?: string | null): string {
  const info = currencyInfo(code);
  try {
    const part = new Intl.NumberFormat(info.locale, { style: 'currency', currency: info.code })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? info.code;
  } catch {
    return info.code;
  }
}
