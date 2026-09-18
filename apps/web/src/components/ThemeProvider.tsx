'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_THEME,
  PRESETS,
  STORAGE_KEY,
  applyTheme,
  loadTheme,
  loadThemeFrom,
  saveTheme,
  type Appearance,
  type ThemeState,
  type ThemeTokens,
} from '@/lib/theme';

// React fires effect (useEffect) cleanup/setup child-before-parent, so a
// nested, tenant-scoped provider always finishes its own mount effect
// before the unscoped root provider's runs. Without this flag the root's
// effect would then unconditionally re-apply the DEFAULT/global theme to
// the same <html> element and silently clobber the tenant's Brand Kit on
// every fresh page load (state-only updates are fine — only the instance
// whose own state changed re-renders — this race is a first-mount-only
// hazard). The flag lets the root detect "a more specific instance already
// claimed <html> this commit" and back off instead.
const THEME_OWNER_ATTR = 'themeOwner';

type Ctx = {
  theme: ThemeState;
  setPreset: (name: string) => void;
  setPrimary: (channels: string) => void;
  setRadius: (px: string) => void;
  setAppearance: (a: Appearance) => void;
  setToken: (key: keyof ThemeTokens, value: string) => void;
};

const ThemeContext = createContext<Ctx | null>(null);

/**
 * `initialTheme`/`storageKey` let a tenant-scoped instance seed itself from
 * a restaurant's server-persisted Brand Kit and keep live edits isolated
 * per-restaurant-per-browser (so two restaurants viewed in the same
 * browser never bleed into each other's localStorage key). The root
 * layout mounts one plain `<ThemeProvider>` (no props, `scoped` defaults
 * to false) for pages outside any tenant context; each portal layout
 * mounts a second, nested one with `scoped` — see THEME_OWNER_ATTR above
 * for why that flag, not nesting order, is what makes the tenant instance
 * win.
 */
export function ThemeProvider({
  children,
  initialTheme,
  persist = true,
  storageKey = STORAGE_KEY,
  scoped = false,
}: {
  children: React.ReactNode;
  initialTheme?: ThemeState;
  persist?: boolean;
  storageKey?: string;
  scoped?: boolean;
}) {
  const [theme, setTheme] = useState<ThemeState>(initialTheme ?? DEFAULT_THEME);

  // Hydrate from this provider's own storage slot once on mount (a locally
  // unsaved edit wins over the server value so an in-progress preview
  // survives a refresh), then keep <html> in sync on every change.
  useEffect(() => {
    if (persist) setTheme(loadThemeFrom(storageKey, initialTheme ?? DEFAULT_THEME));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (scoped) {
      root.dataset[THEME_OWNER_ATTR] = 'scoped';
    } else if (root.dataset[THEME_OWNER_ATTR] === 'scoped') {
      return; // a tenant-scoped provider elsewhere on this page already owns <html>
    }
    applyTheme(theme);
    if (persist) saveTheme(theme, storageKey);
  }, [theme, persist, storageKey, scoped]);
  // On leaving a tenant route (this instance unmounts, the root one
  // doesn't), release ownership and restore whatever the global/unscoped
  // theme actually is — otherwise <html> would be stuck showing this
  // restaurant's Brand Kit on the page the visitor navigated to next.
  useEffect(() => {
    if (!scoped) return;
    return () => {
      const root = document.documentElement;
      if (root.dataset[THEME_OWNER_ATTR] === 'scoped') {
        delete root.dataset[THEME_OWNER_ATTR];
        applyTheme(loadTheme());
      }
    };
  }, [scoped]);

  const setPreset = useCallback((name: string) => {
    const tokens = PRESETS[name];
    if (tokens) setTheme((t) => ({ ...t, preset: name, tokens }));
  }, []);
  const setPrimary = useCallback((channels: string) => {
    setTheme((t) => ({ ...t, preset: 'Custom', tokens: { ...t.tokens, primary: channels } }));
  }, []);
  const setRadius = useCallback((px: string) => {
    setTheme((t) => ({ ...t, preset: 'Custom', tokens: { ...t.tokens, radius: px } }));
  }, []);
  const setAppearance = useCallback((a: Appearance) => {
    setTheme((t) => ({ ...t, appearance: a }));
  }, []);
  const setToken = useCallback((key: keyof ThemeTokens, value: string) => {
    setTheme((t) => ({ ...t, preset: 'Custom', tokens: { ...t.tokens, [key]: value } }));
  }, []);

  const value = useMemo(
    () => ({ theme, setPreset, setPrimary, setRadius, setAppearance, setToken }),
    [theme, setPreset, setPrimary, setRadius, setAppearance, setToken],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
