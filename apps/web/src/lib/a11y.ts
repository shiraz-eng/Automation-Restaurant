'use client';

import { useSyncExternalStore } from 'react';
import { A11Y_STORAGE_KEY } from './a11yScript';

/**
 * Accessibility preferences — chosen once per device and applied to every
 * page (website, portals, kiosk portals, customer menu, admin) by setting
 * data attributes on <html> that globals.css responds to. The root layout's
 * inline script applies the stored choice before first paint, so there is
 * no flash of the default.
 */
export type A11yPrefs = {
  /** Root text size in percent; every rem-based size (text and spacing) follows it. */
  text: 100 | 112 | 125 | 150;
  contrast: 'standard' | 'high';
  /** 'system' follows the operating system's reduce-motion setting; 'reduce' always reduces. */
  motion: 'system' | 'reduce';
  underlineLinks: boolean;
  /** Wider letter, word and line spacing. */
  spacing: boolean;
  /** Bigger buttons and form controls for touch. */
  largeTargets: boolean;
};

export const DEFAULT_A11Y: A11yPrefs = {
  text: 100,
  contrast: 'standard',
  motion: 'system',
  underlineLinks: false,
  spacing: false,
  largeTargets: false,
};

const TEXT_SIZES = [100, 112, 125, 150] as const;

function clean(raw: Partial<A11yPrefs> | null | undefined): A11yPrefs {
  const r = raw ?? {};
  return {
    text: TEXT_SIZES.includes(r.text as A11yPrefs['text']) ? (r.text as A11yPrefs['text']) : 100,
    contrast: r.contrast === 'high' ? 'high' : 'standard',
    motion: r.motion === 'reduce' ? 'reduce' : 'system',
    underlineLinks: r.underlineLinks === true,
    spacing: r.spacing === true,
    largeTargets: r.largeTargets === true,
  };
}

/** Writes the attributes globals.css reads. Kept in step with A11Y_NO_FLASH (a11yScript.ts). */
export function applyA11y(p: A11yPrefs) {
  const el = document.documentElement;
  const set = (name: string, on: boolean, value: string) => (on ? el.setAttribute(name, value) : el.removeAttribute(name));
  set('data-a11y-text', p.text !== 100, String(p.text));
  set('data-a11y-contrast', p.contrast === 'high', 'high');
  set('data-a11y-motion', p.motion === 'reduce', 'reduce');
  set('data-a11y-links', p.underlineLinks, 'underline');
  set('data-a11y-spacing', p.spacing, 'wide');
  set('data-a11y-targets', p.largeTargets, 'large');
}


let cached: A11yPrefs | null = null;
const listeners = new Set<() => void>();

function read(): A11yPrefs {
  if (cached) return cached;
  try {
    cached = clean(JSON.parse(localStorage.getItem(A11Y_STORAGE_KEY) || '{}') as Partial<A11yPrefs>);
  } catch {
    cached = DEFAULT_A11Y;
  }
  return cached;
}

export function setA11y(patch: Partial<A11yPrefs>) {
  cached = clean({ ...read(), ...patch });
  try {
    localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(cached));
  } catch {
    /* applied for this page even if it can't be stored */
  }
  applyA11y(cached);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab changed it: follow along.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== A11Y_STORAGE_KEY) return;
    cached = null;
    applyA11y(read());
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function useA11y(): [A11yPrefs, (patch: Partial<A11yPrefs>) => void] {
  return [useSyncExternalStore(subscribe, read, () => DEFAULT_A11Y), setA11y];
}
