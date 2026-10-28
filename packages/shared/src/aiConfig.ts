import { normalizeLanguageChoice, detectLanguage, isAiLanguageCode, type AiLanguageChoice } from './aiLanguages';

/**
 * Per-module AI settings: one restaurant-wide default ('global') plus an
 * optional override for each module. Stored in the restaurant's own database
 * (tenant-migrations/0108, public.ai_module_settings) and only ever written
 * by the API after a permission check.
 *
 * Settings shape the languages the assistant uses and whether voice is offered —
 * never what it may see or do. Data access is always the signed-in person's
 * own permissions, whatever a module's settings say.
 */
export type AiModuleKey =
  | 'global'
  | 'pos'
  | 'kitchen'
  | 'menu'
  | 'marketing'
  | 'inventory'
  | 'suppliers'
  | 'finance'
  | 'staff'
  | 'manager'
  | 'admin'
  | 'customer';

export const AI_MODULES: { key: AiModuleKey; label: string; focus: string }[] = [
  { key: 'global', label: 'All modules (default)', focus: '' },
  {
    key: 'pos',
    label: 'POS & Orders',
    focus: 'the POS: taking orders, open bills, checkout and payments, receipts, refunds and discounts, tables and QR ordering. Prefer order and sales tools; explain the order workflow step by step when asked.',
  },
  {
    key: 'kitchen',
    label: 'Kitchen',
    focus: 'the Kitchen Display: pending and in-progress tickets, preparation status, station load, ticket times, food availability and waste. Prefer kitchen, order-status and availability tools.',
  },
  {
    key: 'menu',
    label: 'Menu & Deals',
    focus: 'the menu: dishes, categories, sizes and add-ons, prices, images and combo deals. Prefer menu, item performance and deal tools.',
  },
  {
    key: 'marketing',
    label: 'Marketing',
    focus: 'marketing: promotions and discount codes, social media posts, and guest reviews and ratings. Prefer promotion, feedback and sales-trend tools; draft copy when asked.',
  },
  {
    key: 'inventory',
    label: 'Inventory',
    focus: 'inventory: ingredient stock levels, low-stock items, reorder levels, recipes and food cost, waste (amounts, reasons, trends, expiry risks), and dish availability. Prefer stock, low-stock, wastage, expiry, recipe and availability tools — never estimate a stock level.',
  },
  {
    key: 'suppliers',
    label: 'Suppliers & Purchasing',
    focus: 'suppliers and purchasing: supplier records and prices, purchase orders, receiving, supplier invoices and what is owed. Prefer supplier, purchase-order and payables tools.',
  },
  {
    key: 'finance',
    label: 'Finance',
    focus: 'finance: revenue, net sales, expenses, profit, food cost, payables, the ledger and day close. Prefer the profitability, expense and ledger tools, and label estimates as estimates.',
  },
  {
    key: 'staff',
    label: 'Staff',
    focus: 'staff: the team, roles and permissions, shifts, attendance and station logins.',
  },
  {
    key: 'manager',
    label: 'Manager dashboard & reports',
    focus: "the manager's dashboard: today's performance, trends, best sellers, what needs attention, and reports and exports.",
  },
  {
    key: 'admin',
    label: 'Admin & settings',
    focus: 'settings and administration: brand kit, currency, tax, refund rules, branches, billing, users and permissions. Explain what each setting changes; only the person’s own role decides what they can change.',
  },
  {
    key: 'customer',
    label: 'Customer ordering',
    focus: '',
  },
];

export function isAiModuleKey(v: unknown): v is AiModuleKey {
  return typeof v === 'string' && AI_MODULES.some((m) => m.key === v);
}

export type AiModuleSettings = {
  /** Language speech recognition listens for ('auto' = the person's own choice / browser language). */
  inputLanguage: AiLanguageChoice;
  /** Language answers are written in ('auto' = the language of the question). */
  responseLanguage: AiLanguageChoice;
  /** Detect the language of each message (off = always use the fixed languages above). */
  autoDetect: boolean;
  voiceInput: boolean;
  voiceOutput: boolean;
  /** A preferred speech voice name; used when the viewer's device has it. */
  voiceName: string | null;
};

/** A module's stored override: anything left out inherits from 'global'. */
export type AiModuleOverride = Partial<AiModuleSettings>;

export const DEFAULT_AI_SETTINGS: AiModuleSettings = {
  inputLanguage: 'auto',
  responseLanguage: 'auto',
  autoDetect: true,
  voiceInput: true,
  voiceOutput: true,
  voiceName: null,
};

/** Coerces untrusted input (a request body or a stored row) to a clean override. */
export function sanitizeAiOverride(raw: unknown): AiModuleOverride {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AiModuleOverride = {};
  if (r.inputLanguage !== undefined && r.inputLanguage !== null) out.inputLanguage = normalizeLanguageChoice(r.inputLanguage);
  if (r.responseLanguage !== undefined && r.responseLanguage !== null) out.responseLanguage = normalizeLanguageChoice(r.responseLanguage);
  if (typeof r.autoDetect === 'boolean') out.autoDetect = r.autoDetect;
  if (typeof r.voiceInput === 'boolean') out.voiceInput = r.voiceInput;
  if (typeof r.voiceOutput === 'boolean') out.voiceOutput = r.voiceOutput;
  if (r.voiceName === null) out.voiceName = null;
  else if (typeof r.voiceName === 'string' && r.voiceName.trim()) out.voiceName = r.voiceName.trim().slice(0, 120);
  return out;
}

/** Built-in defaults ← restaurant default ← module override. */
export function resolveAiSettings(globalOverride: AiModuleOverride | null | undefined, moduleOverride?: AiModuleOverride | null): AiModuleSettings {
  return { ...DEFAULT_AI_SETTINGS, ...stripUndefined(globalOverride), ...stripUndefined(moduleOverride) };
}

function stripUndefined<T extends object>(o: T | null | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Which response language applies: the person's own choice (this device)
 * first, then the module's setting, then — when detection is on — the
 * language of the message itself.
 */
export function effectiveResponseLanguage(
  userChoice: AiLanguageChoice | null | undefined,
  settings: Pick<AiModuleSettings, 'responseLanguage' | 'inputLanguage' | 'autoDetect'>,
  lastMessage: string,
): string {
  const choice = responseLanguageChoice(userChoice, settings);
  return choice === 'auto' ? (detectLanguage(lastMessage)?.code ?? 'en') : choice;
}

/** The same decision before a message exists: a fixed language code, or 'auto' (follow each message). */
export function responseLanguageChoice(
  userChoice: AiLanguageChoice | null | undefined,
  settings: Pick<AiModuleSettings, 'responseLanguage' | 'inputLanguage' | 'autoDetect'>,
): AiLanguageChoice {
  if (userChoice && userChoice !== 'auto' && isAiLanguageCode(userChoice)) return userChoice;
  if (settings.responseLanguage !== 'auto' && isAiLanguageCode(settings.responseLanguage)) return settings.responseLanguage;
  if (settings.autoDetect) return 'auto';
  return isAiLanguageCode(settings.inputLanguage) ? settings.inputLanguage : 'en';
}

/** The prompt line telling the model which module the person is working in. */
export function moduleFocusInstruction(module: AiModuleKey): string {
  const m = AI_MODULES.find((x) => x.key === module);
  if (!m || !m.focus) return '';
  return `CURRENT MODULE: The person is working in ${m.label}. Lean towards ${m.focus} They can still ask about anything else — answer it the same way. The module never changes what you may see or do: that is decided only by the tools you were given, which follow this person's own permissions.`;
}

/**
 * The AI module a portal or storefront path belongs to. `path` is a pathname
 * such as /r/bbq-tonight/inventory or /order/bbq-tonight.
 */
export function aiModuleForPath(path: string | null | undefined): AiModuleKey {
  const p = (path ?? '').split(/[?#]/)[0] ?? '';
  if (/^\/order\//.test(p)) return 'customer';
  const m = /^\/r\/[^/]+\/?(.*)$/.exec(p);
  if (!m) return 'global';
  const rest = m[1]!.replace(/\/+$/, '');
  if (rest.startsWith('modules/')) {
    const k = rest.slice('modules/'.length).split('/')[0];
    const map: Record<string, AiModuleKey> = {
      pos: 'pos', kitchen: 'kitchen', menu: 'menu', marketing: 'marketing', inventory: 'inventory', suppliers: 'suppliers',
      finance: 'finance', staff: 'staff', analytics: 'manager', settings: 'admin',
    };
    return (k && map[k]) || 'global';
  }
  const rules: [RegExp, AiModuleKey][] = [
    [/^menu\/(availability|priority)/, 'inventory'],
    [/^(checkout|orders|live|tables|exceptions|register|close)(\/|$)/, 'pos'],
    [/^kds(\/|$)/, 'kitchen'],
    [/^(menu|deals)(\/|$)/, 'menu'],
    [/^(promotions|social|reviews)(\/|$)/, 'marketing'],
    [/^(inventory|recipes)(\/|$)/, 'inventory'],
    [/^(suppliers|purchasing)(\/|$)/, 'suppliers'],
    [/^(finance|expenses)(\/|$)/, 'finance'],
    [/^(staff|scheduling|portals)(\/|$)/, 'staff'],
    [/^(exports|audit)(\/|$)/, 'manager'],
    [/^$/, 'manager'],
    [/^(settings|branches|billing)(\/|$)/, 'admin'],
  ];
  for (const [re, key] of rules) if (re.test(rest)) return key;
  return 'global';
}
