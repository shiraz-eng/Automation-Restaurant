'use client';

import { useId } from 'react';
import { Globe } from 'lucide-react';
import { AI_LANGUAGES } from '@automation-restaurant/shared';
import { setUiLanguage, useUiLanguage } from '@/lib/i18n/uiLanguage';

// Roman Urdu is a way of typing to the AI, not a screen language.
const OPTIONS = [{ code: 'en', native: 'English' }, ...AI_LANGUAGES.filter((l) => l.code !== 'en' && l.code !== 'ur-Latn')];

/**
 * The portal's screen language (this device). Urdu is translated ahead of time;
 * other languages are translated by the AI the first time each text appears.
 * The names are shown in their own language and never translated.
 */
export function LanguageMenu({ className = '' }: { className?: string }) {
  const lang = useUiLanguage();
  const id = useId();
  return (
    <div translate="no" className={`relative flex items-center ${className}`}>
      <label htmlFor={id} className="sr-only">
        Language / زبان
      </label>
      <Globe size={15} aria-hidden className="pointer-events-none absolute start-2.5 text-muted" />
      <select
        id={id}
        value={lang}
        onChange={(e) => setUiLanguage(e.target.value)}
        title="Language / زبان"
        className="h-9 max-w-[7.5rem] cursor-pointer appearance-none rounded-lg border border-border bg-surface ps-8 pe-2 text-[0.75rem] font-semibold text-body hover:bg-main"
      >
        {OPTIONS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.native}
          </option>
        ))}
      </select>
    </div>
  );
}
