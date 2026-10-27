'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_AI_SETTINGS, type AiModuleKey, type AiModuleSettings } from '@automation-restaurant/shared';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ModuleAiConfig = {
  settings: AiModuleSettings;
  /** The API can transcribe recordings (browsers without built-in recognition). */
  serverTranscription: boolean;
  /** The API can read answers aloud in any language. */
  serverVoice: boolean;
  loaded: boolean;
};

const cache = new Map<string, { at: number; value: ModuleAiConfig }>();
const TTL = 5 * 60_000;

/**
 * The restaurant's AI settings for one module (GET /api/ai/config): which
 * voice features are switched on and the default languages. Public pages
 * (no restaurant) get the built-in defaults. A failed fetch also falls back
 * to the defaults — voice and language still work, just unconfigured.
 */
export function useModuleAiConfig(slug: string | undefined, module: AiModuleKey, getToken?: () => Promise<string | null>): ModuleAiConfig {
  const key = `${slug ?? ''}:${module}`;
  const hit = cache.get(key);
  const [value, setValue] = useState<ModuleAiConfig>(
    hit && Date.now() - hit.at < TTL ? hit.value : { settings: DEFAULT_AI_SETTINGS, serverTranscription: false, serverVoice: false, loaded: !slug },
  );
  useEffect(() => {
    if (!slug || !getToken) return;
    const h = cache.get(key);
    if (h && Date.now() - h.at < TTL) {
      setValue(h.value);
      return;
    }
    let live = true;
    (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error('no session');
        const res = await fetch(`${API}/api/ai/config?slug=${encodeURIComponent(slug)}&module=${module}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { settings?: AiModuleSettings; serverTranscription?: boolean; serverVoice?: boolean };
        const v: ModuleAiConfig = { settings: { ...DEFAULT_AI_SETTINGS, ...j.settings }, serverTranscription: !!j.serverTranscription, serverVoice: !!j.serverVoice, loaded: true };
        cache.set(key, { at: Date.now(), value: v });
        if (live) setValue(v);
      } catch {
        if (live) setValue({ settings: DEFAULT_AI_SETTINGS, serverTranscription: false, serverVoice: false, loaded: true });
      }
    })();
    return () => {
      live = false;
    };
    // getToken is a fresh closure each render; the key decides when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

/** Drops cached settings after an admin saves new ones on this device. */
export function clearModuleAiConfigCache() {
  cache.clear();
}
