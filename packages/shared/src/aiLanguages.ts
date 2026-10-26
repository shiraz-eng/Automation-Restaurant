/**
 * Languages the AI features offer, shared by the API (prompts, transcription)
 * and the web app (selectors, speech, right-to-left layout).
 *
 * The AI models answer in any of these; speech depends on the device:
 *   stt  BCP-47 tag handed to speech recognition (browser or server)
 *   tts  BCP-47 tag used to pick a speech-synthesis voice
 * A device without a voice for a language still shows the answer as text.
 */
export type AiLanguage = {
  code: string;
  /** English name (settings screens, prompts). */
  name: string;
  /** The name in the language itself (selectors). */
  native: string;
  dir: 'ltr' | 'rtl';
  stt: string;
  tts: string;
  /** How the model should write it — said explicitly so Urdu never comes back in Arabic script, etc. */
  script: string;
};

export const AI_LANGUAGES: AiLanguage[] = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr', stt: 'en-US', tts: 'en-US', script: 'Latin script' },
  { code: 'ur', name: 'Urdu', native: 'اردو', dir: 'rtl', stt: 'ur-PK', tts: 'ur-PK', script: 'Urdu (Nastaliq/Arabic) script' },
  { code: 'ur-Latn', name: 'Roman Urdu', native: 'Roman Urdu', dir: 'ltr', stt: 'ur-PK', tts: 'en-IN', script: 'Latin letters (Roman Urdu, as typed on WhatsApp)' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr', stt: 'hi-IN', tts: 'hi-IN', script: 'Devanagari script' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl', stt: 'ar-SA', tts: 'ar-SA', script: 'Arabic script' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', dir: 'ltr', stt: 'pa-IN', tts: 'pa-IN', script: 'Gurmukhi script' },
  { code: 'ps', name: 'Pashto', native: 'پښتو', dir: 'rtl', stt: 'ps-AF', tts: 'ps-AF', script: 'Pashto (Arabic) script' },
  { code: 'fa', name: 'Persian', native: 'فارسی', dir: 'rtl', stt: 'fa-IR', tts: 'fa-IR', script: 'Persian (Arabic) script' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', dir: 'ltr', stt: 'bn-BD', tts: 'bn-BD', script: 'Bengali script' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', dir: 'ltr', stt: 'tr-TR', tts: 'tr-TR', script: 'Latin script' },
  { code: 'fr', name: 'French', native: 'Français', dir: 'ltr', stt: 'fr-FR', tts: 'fr-FR', script: 'Latin script' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr', stt: 'es-ES', tts: 'es-ES', script: 'Latin script' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr', stt: 'de-DE', tts: 'de-DE', script: 'Latin script' },
  { code: 'zh', name: 'Chinese', native: '中文', dir: 'ltr', stt: 'zh-CN', tts: 'zh-CN', script: 'Simplified Chinese characters' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', dir: 'ltr', stt: 'ms-MY', tts: 'ms-MY', script: 'Latin script' },
];

/** 'auto' = detect from what the person typed or said. */
export type AiLanguageChoice = 'auto' | string;

const BY_CODE = new Map(AI_LANGUAGES.map((l) => [l.code, l]));

export function aiLanguage(code: string | null | undefined): AiLanguage | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

export function isAiLanguageCode(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}

/** A stored or requested choice, kept only if it is 'auto' or a known language. */
export function normalizeLanguageChoice(code: unknown): AiLanguageChoice {
  return code === 'auto' || isAiLanguageCode(code) ? (code as string) : 'auto';
}

export function isRtlLanguage(code: string | null | undefined): boolean {
  return aiLanguage(code)?.dir === 'rtl';
}

// ── Detection ────────────────────────────────────────────────────────────────
// A fast, offline first guess used for the UI (direction, which voice reads
// the answer) and as a hint in the prompt. The model itself still reads the
// message, so a wrong guess on a two-word message never changes the meaning.

const RANGES: [string, RegExp][] = [
  ['arabic', /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['bengali', /[ঀ-৿]/g],
  ['gurmukhi', /[਀-੿]/g],
  ['han', /[一-鿿㐀-䶿]/g],
  ['latin', /[A-Za-zÀ-ɏ]/g],
];

// Letters only Urdu uses (ٹ ڈ ڑ ں ے ھ ہ ۂ ۓ).
const URDU_ONLY = /[ٹڈڑںےھہۂۓ]/;
// Letters only Pashto uses (ټ ډ ړ ښ ږ ځ څ ۍ ې).
const PASHTO_ONLY = /[ټډړښږځڅۍې]/;
// Persian-family letters (پ چ ژ گ ک ی) — Urdu and Persian, never standard Arabic.
const PERSO = /[پچژگکی]/;
const URDU_WORDS = /(^|\s)(ہے|ہیں|کیا|کی|کے|کا|میں|نہیں|اور|کو|سے|آج|کتنا|کتنی|کتنے|ہم|آپ|یہ|وہ|بتائیں|بتاؤ)(?=\s|$|[؟?!.،])/;

// Common Roman Urdu / Hindi words that are rarely English words.
const ROMAN_URDU = new Set(
  'hai hain kya kia kitna kitni kitne mujhe mera meri aap ap apna apni nahi nahin nai kaise kaisa kaisi batao bataen bataiye btao kar karo karna karein kardo krdo krna kro dena dedo lena kahan kab aur bhi wala wali abhi aaj kal chahiye chaiye hoga hogi raha rahi rahe hua hui tha thi thay yeh ye woh wo kuch koi sab bohat bahut zyada kam jaldi dikhao dikhaen bhejo lagao hatao kitny kyun kyon theek thik acha accha shukriya'.split(' '),
);
// Short particles that also count, but only alongside a stronger word.
const ROMAN_PARTICLES = new Set('ka ki ke ko se mein me main hum tum do na'.split(' '));

const LATIN_STOPWORDS: [string, Set<string>][] = [
  ['fr', new Set('le la les des est une un et que pour pas avec dans je vous nous combien quel quelle'.split(' '))],
  ['es', new Set('el la los las es una un y que para no con en yo usted cuanto cuánto qué cómo hay'.split(' '))],
  ['de', new Set('der die das ist ein eine und nicht mit ich sie wir wie viel was gibt heute'.split(' '))],
  ['tr', new Set('bir ve bu ne nasıl kaç var mı mi için çok değil bugün stok'.split(' '))],
  ['ms', new Set('saya anda berapa apa hari ini tidak ada dan yang untuk dengan'.split(' '))],
];

export type DetectedLanguage = { code: string; confidence: 'high' | 'low' };

/** Best guess at the language of `text`; null when there is too little to go on. */
export function detectLanguage(text: string | null | undefined): DetectedLanguage | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  const counts = RANGES.map(([name, re]) => [name, (s.match(re) ?? []).length] as const);
  const [script, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (n === 0) return null;

  if (script === 'arabic') {
    if (URDU_ONLY.test(s)) return { code: 'ur', confidence: 'high' };
    if (PASHTO_ONLY.test(s)) return { code: 'ps', confidence: 'high' };
    if (PERSO.test(s)) return URDU_WORDS.test(s) ? { code: 'ur', confidence: 'high' } : { code: 'fa', confidence: 'low' };
    return { code: 'ar', confidence: n >= 4 ? 'high' : 'low' };
  }
  if (script === 'devanagari') return { code: 'hi', confidence: 'high' };
  if (script === 'bengali') return { code: 'bn', confidence: 'high' };
  if (script === 'gurmukhi') return { code: 'pa', confidence: 'high' };
  if (script === 'han') return { code: 'zh', confidence: 'high' };

  // Latin script: Roman Urdu, a few European languages, else English.
  const words = s.toLowerCase().normalize('NFC').match(/[a-zÀ-ɏ]+/g) ?? [];
  if (words.length === 0) return null;
  let strong = 0;
  let particles = 0;
  for (const w of words) {
    if (ROMAN_URDU.has(w)) strong++;
    else if (ROMAN_PARTICLES.has(w)) particles++;
  }
  if (strong >= 2 || (strong >= 1 && strong + particles >= 2) || (strong >= 1 && words.length <= 3)) {
    return { code: 'ur-Latn', confidence: strong + particles >= 3 ? 'high' : 'low' };
  }
  let best: [string, number] = ['en', 0];
  for (const [code, set] of LATIN_STOPWORDS) {
    const hits = words.filter((w) => set.has(w)).length;
    if (hits > best[1]) best = [code, hits];
  }
  if (best[1] >= 2 && best[1] / words.length >= 0.2) return { code: best[0], confidence: 'low' };
  return { code: 'en', confidence: words.length >= 3 ? 'high' : 'low' };
}

/**
 * The language an answer should be written in: an explicit choice wins,
 * otherwise whatever the person's message is in (English if unknown).
 */
export function resolveResponseLanguage(choice: AiLanguageChoice | null | undefined, lastMessage: string): string {
  if (choice && choice !== 'auto' && isAiLanguageCode(choice)) return choice;
  return detectLanguage(lastMessage)?.code ?? 'en';
}

/**
 * The instruction added to an AI system prompt so answers come back in the
 * right language without losing figures, names or app terms.
 */
export function languageInstruction(choice: AiLanguageChoice | null | undefined, lastMessage: string): string {
  const detected = detectLanguage(lastMessage);
  const keep =
    'Keep every number, amount, currency symbol or code (Rs, PKR, AED, $), percentage, date, time, order number, dish name, ingredient name, person or supplier name exactly as they are — never convert currencies or change figures. Use Western digits (0-9). Keep the names of app screens and buttons (e.g. "Inventory", "Priority Allocation", "Checkout") in English so the person can find them, adding a translation in brackets if helpful.';
  const fixed = choice && choice !== 'auto' ? aiLanguage(choice) : undefined;
  if (fixed) {
    return `RESPONSE LANGUAGE: Always write your reply in ${fixed.name} (${fixed.native}), using ${fixed.script} — even if the person writes or speaks in another language${detected && detected.code !== fixed.code ? ` (their message looks like ${aiLanguage(detected.code)?.name ?? 'another language'})` : ''}. Understand their message in whatever language it is, then answer in ${fixed.name}. ${keep} Earlier turns of the conversation may be in other languages; keep their meaning and context.`;
  }
  const hint = detected ? aiLanguage(detected.code) : undefined;
  return `RESPONSE LANGUAGE: Reply in the same language and script as the person's latest message (Urdu script → Urdu script, Roman Urdu → Roman Urdu, Hindi → Devanagari, Arabic → Arabic, English → English).${hint ? ` Their latest message looks like ${hint.name}${detected!.confidence === 'low' ? ' (a rough guess — trust the message itself)' : ''}.` : ''} If they switch language mid-conversation, switch with them and keep the context. ${keep}`;
}
