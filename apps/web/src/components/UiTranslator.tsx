'use client';

import { useEffect } from 'react';
import { useOptionalPortalSupabase } from './PortalProvider';
import { useUiLanguage } from '@/lib/i18n/uiLanguage';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// Bundled dictionaries, loaded only when that language is chosen.
const DICTS: Record<string, () => Promise<Record<string, string>>> = {
  ur: () => import('@/lib/i18n/dict/ur.json').then((m) => m.default as Record<string, string>),
  hi: () => import('@/lib/i18n/dict/hi.json').then((m) => m.default as Record<string, string>),
};

/**
 * Translates a restaurant page into the language chosen on this device
 * (LanguageMenu). Inside a portal it also asks the API for text the bundled
 * dictionary doesn't have yet; on the sign-in page it uses the dictionary only.
 */
export function UiTranslator({ slug }: { slug: string }) {
  const lang = useUiLanguage();
  const supabase = useOptionalPortalSupabase();

  useEffect(() => {
    const html = document.documentElement;
    if (lang === 'en') {
      html.removeAttribute('data-ui-pending');
      return;
    }
    let stopped = false;
    let translator: { stop: () => void } | null = null;
    (async () => {
      const [{ DomTranslator }, dict] = await Promise.all([import('@/lib/i18n/domTranslator'), (DICTS[lang] ?? (async () => ({})))().catch(() => ({}))]);
      if (stopped) return;
      const fetchMissing = supabase
        ? async (keys: string[]) => {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            if (!token) return {};
            const res = await fetch(`${API}/api/ai/translate-ui`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ slug, language: lang, strings: keys }),
            });
            if (!res.ok) throw new Error(String(res.status));
            return ((await res.json()) as { translations?: Record<string, string> }).translations ?? {};
          }
        : null;
      const t = new DomTranslator(lang, dict, fetchMissing);
      t.start(document.body);
      translator = t;
      html.removeAttribute('data-ui-pending');
    })().catch(() => html.removeAttribute('data-ui-pending'));
    return () => {
      stopped = true;
      translator?.stop();
    };
  }, [lang, slug, supabase]);

  return null;
}
