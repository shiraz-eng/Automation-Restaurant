'use client';

import { useMemo } from 'react';
import { AI_LANGUAGES, isAiLanguageCode, responseLanguageChoice, type AiLanguageChoice, type AiModuleKey } from '@automation-restaurant/shared';
import { useAiPrefs } from './prefs';
import { useModuleAiConfig } from './moduleSettings';
import { apiTranscriber, type ServerTranscriber } from './speech';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

function browserLanguage(): string {
  if (typeof navigator === 'undefined') return 'en';
  for (const tag of navigator.languages ?? [navigator.language]) {
    const t = tag.toLowerCase();
    const hit = AI_LANGUAGES.find((l) => l.code.toLowerCase() === t || l.stt.toLowerCase() === t) ?? AI_LANGUAGES.find((l) => t.split('-')[0] === l.code);
    if (hit) return hit.code;
  }
  return 'en';
}

/**
 * Everything a chat panel needs to know about language and voice, combined
 * from the restaurant's settings for this module (what is allowed, the
 * defaults) and this device's own choices (what the person picked).
 */
export function useAiVoice(opts: { slug?: string; module: AiModuleKey; getToken?: () => Promise<string | null> }) {
  const { slug, module, getToken } = opts;
  const [prefs, setPrefs] = useAiPrefs();
  const config = useModuleAiConfig(slug, module, getToken);
  const s = config.settings;

  return useMemo(() => {
    const answerChoice: AiLanguageChoice = responseLanguageChoice(prefs.responseLanguage, s);
    const micLanguage =
      prefs.inputLanguage !== 'auto' && isAiLanguageCode(prefs.inputLanguage)
        ? prefs.inputLanguage
        : s.inputLanguage !== 'auto' && isAiLanguageCode(s.inputLanguage)
          ? s.inputLanguage
          : answerChoice !== 'auto'
            ? answerChoice
            : browserLanguage();
    const server: ServerTranscriber | null =
      slug && getToken && config.serverTranscription ? apiTranscriber(API, slug, module, getToken) : null;
    return {
      prefs,
      setPrefs,
      settings: s,
      loaded: config.loaded,
      /** A fixed language code, or 'auto' (each answer follows its question). */
      answerChoice,
      micLanguage,
      /** The restaurant allows it here AND this device has it switched on. */
      micEnabled: s.voiceInput && prefs.voiceInput,
      speakEnabled: s.voiceOutput && prefs.voiceOutput,
      /** Switched off by the restaurant for this module (not by the person). */
      micBlockedByAdmin: !s.voiceInput,
      speakBlockedByAdmin: !s.voiceOutput,
      voiceName: prefs.voiceName ?? s.voiceName,
      rate: prefs.rate,
      server,
    };
    // getToken is a new closure on every render of the caller; slug/module identify it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, setPrefs, s, config.loaded, config.serverTranscription, slug, module]);
}

export type AiVoice = ReturnType<typeof useAiVoice>;
