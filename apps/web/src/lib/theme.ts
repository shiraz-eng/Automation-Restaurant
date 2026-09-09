/**
 * Theme = a set of CSS-variable overrides applied to <html>. Values are
 * "R G B" channel strings to match the rgb(var(--x) / <alpha>) setup in
 * globals.css. Components never read colors any other way (RULE-UI-03).
 */

export type Appearance = 'light' | 'dark' | 'system';

export type ThemeTokens = {
  primary: string;
  'primary-fg': string;
  radius: string; // e.g. "12px"
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
  root.style.setProperty('--primary', state.tokens.primary);
  root.style.setProperty('--primary-fg', state.tokens['primary-fg']);
  root.style.setProperty('--radius', state.tokens.radius);

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

export function saveTheme(state: ThemeState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — theme just won't persist */
  }
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
