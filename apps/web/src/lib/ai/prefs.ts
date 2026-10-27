'use client';

import { useSyncExternalStore } from 'react';
import { normalizeLanguageChoice, type AiLanguageChoice } from '@automation-restaurant/shared';

/**
 * This device's AI language and voice preferences. Kept in the browser
 * rather than the database on purpose: speech voices are installed per
 * device (a phone and a laptop offer different ones), and a shared counter
 * tablet shouldn't follow one person around. The restaurant's per-module AI
 * settings decide what is allowed; these only choose within it.
 */
export type AiPrefs = {
  /** The language answers are written in ('auto' = the module default, else the language of the question). */
  responseLanguage: AiLanguageChoice;
  /** The language spoken to the microphone ('auto' = the module default, else the answer language, else the browser's). */
  inputLanguage: AiLanguageChoice;
  /** Show the microphone. */
  voiceInput: boolean;
  /** Show read-aloud controls on answers. */
  voiceOutput: boolean;
  /** Read each new answer aloud as soon as it's ready. */
  autoSpeak: boolean;
  /** A speech voice name chosen on this device. */
  voiceName: string | null;
  /** Speech rate, 0.7–1.4. */
  rate: number;
  /** Send speech straight to the server transcriber instead of the browser's recogniser. */
  serverSpeech: boolean;
  /** Read answers with the AI voice (any language) even when the device has its own voice. */
  aiVoice: boolean;
};

export const DEFAULT_AI_PREFS: AiPrefs = {
  responseLanguage: 'auto',
  inputLanguage: 'auto',
  voiceInput: true,
  voiceOutput: true,
  autoSpeak: false,
  voiceName: null,
  rate: 1,
  serverSpeech: false,
  aiVoice: false,
};

const KEY = 'ar-ai-prefs';
const listeners = new Set<() => void>();
let cached: AiPrefs | null = null;

function read(): AiPrefs {
  if (cached) return cached;
  let raw: Partial<AiPrefs> = {};
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<AiPrefs>;
  } catch {
    /* storage blocked or corrupt — defaults */
  }
  cached = {
    responseLanguage: normalizeLanguageChoice(raw.responseLanguage),
    inputLanguage: normalizeLanguageChoice(raw.inputLanguage),
    voiceInput: raw.voiceInput !== false,
    voiceOutput: raw.voiceOutput !== false,
    autoSpeak: raw.autoSpeak === true,
    voiceName: typeof raw.voiceName === 'string' && raw.voiceName ? raw.voiceName.slice(0, 120) : null,
    rate: typeof raw.rate === 'number' && raw.rate >= 0.7 && raw.rate <= 1.4 ? raw.rate : 1,
    serverSpeech: raw.serverSpeech === true,
    aiVoice: raw.aiVoice === true,
  };
  return cached;
}

export function setAiPrefs(patch: Partial<AiPrefs>): void {
  cached = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    /* not persisted, still applied for this page */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cached = null;
      l();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAiPrefs(): [AiPrefs, (patch: Partial<AiPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, read, () => DEFAULT_AI_PREFS);
  return [prefs, setAiPrefs];
}
