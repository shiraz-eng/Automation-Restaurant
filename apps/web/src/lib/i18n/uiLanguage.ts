'use client';

import { useSyncExternalStore } from 'react';
import { isAiLanguageCode } from '@automation-restaurant/shared';
import { UI_LANG_STORAGE_KEY } from './uiLanguageScript';

/** 'en' or one of the AI languages (packages/shared AI_LANGUAGES). */
export type UiLanguage = string;

function read(): UiLanguage {
  try {
    // Only restaurant pages are translated (the website and admin stay English).
    if (!location.pathname.startsWith('/r/')) return 'en';
    const v = localStorage.getItem(UI_LANG_STORAGE_KEY);
    return v && isAiLanguageCode(v) ? v : 'en';
  } catch {
    return 'en';
  }
}

/**
 * Switching language reloads the page: English comes back exactly as the app
 * renders it, and a new language is applied from the first paint.
 */
export function setUiLanguage(lang: UiLanguage) {
  try {
    if (lang === 'en') localStorage.removeItem(UI_LANG_STORAGE_KEY);
    else localStorage.setItem(UI_LANG_STORAGE_KEY, lang);
  } catch {
    /* storage blocked: nothing to persist */
  }
  window.location.reload();
}

const noop = () => () => {};

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(noop, read, () => 'en');
}

/** For non-React code (AI language defaults). */
export function currentUiLanguage(): UiLanguage {
  return typeof window === 'undefined' ? 'en' : read();
}
