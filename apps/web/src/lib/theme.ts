/**
 * Theme = a set of CSS-variable overrides applied to <html>. Values are
 * "R G B" channel strings to match the rgb(var(--x) / <alpha>) setup in
 * globals.css. Components never read colors any other way (RULE-UI-03).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Appearance = 'light' | 'dark' | 'system';

export type ThemeTokens = {
  primary: string;
  'primary-fg': string;
  radius: string; // e.g. "12px"
  // Optional Brand Kit overrides (RULE-BRAND-22: every one of these has a
  // safe default — globals.css's own light/dark rules — so an unset value
  // must be left alone, not forced, or a restaurant with no Brand Kit
  // configured would lose automatic dark-mode switching for these vars.
  'bg-main'?: string;
  'bg-surface'?: string;
  border?: string;
  'text-body'?: string;
  'text-muted'?: string;
};

export type ThemeState = {
  preset: string;
  appearance: Appearance;
  tokens: ThemeTokens;
};

export const PRESETS: Record<string, ThemeTokens> = {
  'Warm Orange': { primary: '234 88 12', 'primary-fg': '255 255 255', radius: '12px' },
  'Fresh Green': { primary: '22 163 74', 'primary-fg': '255 255 255', radius: '12px' },
  'Elegant Burgundy': { primary: '159 18 57', 'primary-fg': '255 255 255', radius: '10px' },
  'Ocean Blue': { primary: '2 132 199', 'primary-fg': '255 255 255', radius: '12px' },
  'Royal Purple': { primary: '124 58 237', 'primary-fg': '255 255 255', radius: '14px' },
  'Minimal Black': { primary: '24 24 27', 'primary-fg': '255 255 255', radius: '8px' },
  'Soft Neutral': { primary: '87 83 78', 'primary-fg': '255 255 255', radius: '16px' },
};

export const DEFAULT_THEME: ThemeState = {
  preset: 'Warm Orange',
  appearance: 'system',
  tokens: PRESETS['Warm Orange'],
};

export const STORAGE_KEY = 'ar-theme';

export function applyTheme(state: ThemeState) {
  const root = document.documentElement;
  const set = (cssVar: string, value?: string) => {
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar); // fall back to globals.css's light/dark rules
  };
  set('--primary', state.tokens.primary);
  set('--primary-fg', state.tokens['primary-fg']);
  set('--radius', state.tokens.radius);
  set('--bg-main', state.tokens['bg-main']);
  set('--bg-surface', state.tokens['bg-surface']);
  set('--border-color', state.tokens.border);
  set('--text-body', state.tokens['text-body']);
  set('--text-muted', state.tokens['text-muted']);

  if (state.appearance === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.appearance);
}

export function loadTheme(): ThemeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      preset: parsed.preset ?? DEFAULT_THEME.preset,
      appearance: parsed.appearance ?? DEFAULT_THEME.appearance,
      tokens: { ...DEFAULT_THEME.tokens, ...parsed.tokens },
    };
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Shape of public.get_brand_kit()'s row (tenant-migrations/0046_brand_kit.sql)
 * — the one Brand Kit read path shared by the authenticated portal layout
 * and any guest-facing surface (storefront, customer AI), so there is only
 * ever one place that turns a persisted Brand Kit into theme tokens.
 */
export type BrandKit = {
  logo_url: string | null;
  primary_color: string | null;
  primary_fg: string | null;
  bg_main: string | null;
  bg_surface: string | null;
  border_color: string | null;
  text_body: string | null;
  text_muted: string | null;
  radius: string | null;
  appearance: Appearance | null;
  meta_title: string | null;
};

export function themeFromBrandKit(kit: BrandKit | null | undefined): ThemeState {
  if (!kit) return DEFAULT_THEME;
  return {
    preset: 'Custom',
    appearance: kit.appearance ?? DEFAULT_THEME.appearance,
    tokens: {
      primary: kit.primary_color || DEFAULT_THEME.tokens.primary,
      'primary-fg': kit.primary_fg || DEFAULT_THEME.tokens['primary-fg'],
      radius: kit.radius || DEFAULT_THEME.tokens.radius,
      ...(kit.bg_main ? { 'bg-main': kit.bg_main } : {}),
      ...(kit.bg_surface ? { 'bg-surface': kit.bg_surface } : {}),
      ...(kit.border_color ? { border: kit.border_color } : {}),
      ...(kit.text_body ? { 'text-body': kit.text_body } : {}),
      ...(kit.text_muted ? { 'text-muted': kit.text_muted } : {}),
    },
  };
}

/**
 * Fetches this restaurant's Brand Kit through the one shared RPC and turns
 * it into ThemeProvider's initial theme + the logo URL. Called once, from
 * the tenant root layout (apps/web/src/app/r/[slug]/layout.tsx) that wraps
 * every route under a restaurant — the staff/owner portal, generated kiosk
 * portals, the dedicated role portals (kitchen/floor/finance/deliveries/
 * register/team), and the login/password-setup pages — so there is exactly
 * one Brand Kit->theme fetch per request tree, not one per layout.
 */
export async function fetchPortalTheme(client: SupabaseClient): Promise<{ initialTheme: ThemeState; logoUrl: string | null }> {
  const { data: brandKitRows } = await client.rpc('get_brand_kit');
  const brandKit = (Array.isArray(brandKitRows) ? brandKitRows[0] : brandKitRows) as BrandKit | null;
  return { initialTheme: themeFromBrandKit(brandKit ?? null), logoUrl: brandKit?.logo_url ?? null };
}

export function loadThemeFrom(storageKey: string, fallback: ThemeState): ThemeState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      preset: parsed.preset ?? fallback.preset,
      appearance: parsed.appearance ?? fallback.appearance,
      tokens: { ...fallback.tokens, ...parsed.tokens },
    };
  } catch {
    return fallback;
  }
}

export function saveTheme(state: ThemeState, storageKey: string = STORAGE_KEY) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* storage unavailable — theme just won't persist */
  }
}

/** CSS custom-property map for a token set — usable as a React inline `style`
 * on any element (custom properties inherit to descendants), not just
 * :root. This is what lets a guest-facing page (no ThemeProvider, no
 * localStorage) scope one restaurant's Brand Kit to its own render tree
 * without ever touching document.documentElement. */
export function cssVarsFromTokens(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {
    '--primary': tokens.primary,
    '--primary-fg': tokens['primary-fg'],
    '--radius': tokens.radius,
  };
  if (tokens['bg-main']) vars['--bg-main'] = tokens['bg-main'];
  if (tokens['bg-surface']) vars['--bg-surface'] = tokens['bg-surface'];
  if (tokens.border) vars['--border-color'] = tokens.border;
  if (tokens['text-body']) vars['--text-body'] = tokens['text-body'];
  if (tokens['text-muted']) vars['--text-muted'] = tokens['text-muted'];
  return vars;
}

/** "234 88 12" -> "#ea580c" for <input type="color"> */
export function channelsToHex(channels: string): string {
  const [r, g, b] = channels.trim().split(/\s+/).map(Number);
  const h = (n: number) => Math.max(0, Math.min(255, n || 0)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** "#ea580c" -> "234 88 12" */
export function hexToChannels(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '0 0 0';
  const int = parseInt(m[1], 16);
  return `${(int >> 16) & 255} ${(int >> 8) & 255} ${int & 255}`;
}
