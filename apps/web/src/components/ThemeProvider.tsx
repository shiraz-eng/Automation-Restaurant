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
  applyTheme,
  loadTheme,
  saveTheme,
  type Appearance,
  type ThemeState,
} from '@/lib/theme';

type Ctx = {
  theme: ThemeState;
  setPreset: (name: string) => void;
  setPrimary: (channels: string) => void;
  setRadius: (px: string) => void;
  setAppearance: (a: Appearance) => void;
};

const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeState>(DEFAULT_THEME);

  // Hydrate from storage once on mount, then keep <html> in sync on every change.
  useEffect(() => {
    setTheme(loadTheme());
  }, []);
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

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

  const value = useMemo(
    () => ({ theme, setPreset, setPrimary, setRadius, setAppearance }),
    [theme, setPreset, setPrimary, setRadius, setAppearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
