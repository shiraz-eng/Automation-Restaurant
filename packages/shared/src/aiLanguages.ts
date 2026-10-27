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
  { code: 'sd', name: 'Sindhi', native: 'سنڌي', dir: 'rtl', stt: 'sd-PK', tts: 'sd-PK', script: 'Sindhi (Arabic) script' },
  { code: 'ne', name: 'Nepali', native: 'नेपाली', dir: 'ltr', stt: 'ne-NP', tts: 'ne-NP', script: 'Devanagari script' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', dir: 'ltr', stt: 'mr-IN', tts: 'mr-IN', script: 'Devanagari script' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', dir: 'ltr', stt: 'gu-IN', tts: 'gu-IN', script: 'Gujarati script' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', dir: 'ltr', stt: 'ta-IN', tts: 'ta-IN', script: 'Tamil script' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', dir: 'ltr', stt: 'te-IN', tts: 'te-IN', script: 'Telugu script' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', dir: 'ltr', stt: 'kn-IN', tts: 'kn-IN', script: 'Kannada script' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', dir: 'ltr', stt: 'ml-IN', tts: 'ml-IN', script: 'Malayalam script' },
  { code: 'si', name: 'Sinhala', native: 'සිංහල', dir: 'ltr', stt: 'si-LK', tts: 'si-LK', script: 'Sinhala script' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr', stt: 'id-ID', tts: 'id-ID', script: 'Latin script' },
  { code: 'th', name: 'Thai', native: 'ไทย', dir: 'ltr', stt: 'th-TH', tts: 'th-TH', script: 'Thai script' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr', stt: 'vi-VN', tts: 'vi-VN', script: 'Latin script (Vietnamese)' },
  { code: 'tl', name: 'Filipino', native: 'Filipino', dir: 'ltr', stt: 'fil-PH', tts: 'fil-PH', script: 'Latin script' },
  { code: 'ja', name: 'Japanese', native: '日本語', dir: 'ltr', stt: 'ja-JP', tts: 'ja-JP', script: 'Japanese (kanji and kana)' },
  { code: 'ko', name: 'Korean', native: '한국어', dir: 'ltr', stt: 'ko-KR', tts: 'ko-KR', script: 'Hangul' },
  { code: 'ru', name: 'Russian', native: 'Русский', dir: 'ltr', stt: 'ru-RU', tts: 'ru-RU', script: 'Cyrillic script' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', dir: 'ltr', stt: 'uk-UA', tts: 'uk-UA', script: 'Cyrillic script' },
  { code: 'pt', name: 'Portuguese', native: 'Português', dir: 'ltr', stt: 'pt-BR', tts: 'pt-BR', script: 'Latin script' },
  { code: 'it', name: 'Italian', native: 'Italiano', dir: 'ltr', stt: 'it-IT', tts: 'it-IT', script: 'Latin script' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', dir: 'ltr', stt: 'nl-NL', tts: 'nl-NL', script: 'Latin script' },
  { code: 'pl', name: 'Polish', native: 'Polski', dir: 'ltr', stt: 'pl-PL', tts: 'pl-PL', script: 'Latin script' },
  { code: 'ro', name: 'Romanian', native: 'Română', dir: 'ltr', stt: 'ro-RO', tts: 'ro-RO', script: 'Latin script' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', dir: 'ltr', stt: 'el-GR', tts: 'el-GR', script: 'Greek script' },
  { code: 'he', name: 'Hebrew', native: 'עברית', dir: 'rtl', stt: 'he-IL', tts: 'he-IL', script: 'Hebrew script' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili', dir: 'ltr', stt: 'sw-KE', tts: 'sw-KE', script: 'Latin script' },
  { code: 'so', name: 'Somali', native: 'Soomaali', dir: 'ltr', stt: 'so-SO', tts: 'so-SO', script: 'Latin script' },
  { code: 'am', name: 'Amharic', native: 'አማርኛ', dir: 'ltr', stt: 'am-ET', tts: 'am-ET', script: 'Ethiopic script' },
  { code: 'uz', name: 'Uzbek', native: 'Oʻzbek', dir: 'ltr', stt: 'uz-UZ', tts: 'uz-UZ', script: 'Latin script' },
  { code: 'kk', name: 'Kazakh', native: 'Қазақ', dir: 'ltr', stt: 'kk-KZ', tts: 'kk-KZ', script: 'Cyrillic script' },
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
  ['kana', /[\u3040-\u30FF]/g],
  ['hangul', /[\uAC00-\uD7AF\u1100-\u11FF]/g],
  ['cyrillic', /[\u0400-\u04FF]/g],
  ['greek', /[\u0370-\u03FF]/g],
  ['hebrew', /[\u0590-\u05FF]/g],
  ['thai', /[\u0E00-\u0E7F]/g],
  ['gujarati', /[\u0A80-\u0AFF]/g],
  ['tamil', /[\u0B80-\u0BFF]/g],
  ['telugu', /[\u0C00-\u0C7F]/g],
  ['kannada', /[\u0C80-\u0CFF]/g],
  ['malayalam', /[\u0D00-\u0D7F]/g],
  ['sinhala', /[\u0D80-\u0DFF]/g],
  ['ethiopic', /[\u1200-\u137F]/g],
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
  ['pt', new Set('o os as um uma não com para que quanto quantos hoje está são do da'.split(' '))],
  ['it', new Set('il lo gli le un una non con per che quanto quanti oggi sono del della'.split(' '))],
  ['nl', new Set('de het een niet met voor dat hoeveel vandaag zijn van ik wij'.split(' '))],
  ['vi', new Set('bao nhiêu hôm nay không có của và là các được món'.split(' '))],
  ['sw', new Set('ni na ya wa kwa leo ngapi hakuna habari chakula'.split(' '))],
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
  // Japanese text mixes kanji with kana; kana alone decides it.
  if (script === 'han') return { code: /[\u3040-\u30FF]/.test(s) ? 'ja' : 'zh', confidence: 'high' };
  if (script === 'cyrillic') return { code: /[іїєґ]/i.test(s) ? 'uk' : /[әғқңөұүһі]/i.test(s) ? 'kk' : 'ru', confidence: 'high' };
  const BY_SCRIPT: Record<string, string> = {
    kana: 'ja', hangul: 'ko', greek: 'el', hebrew: 'he', thai: 'th', gujarati: 'gu', tamil: 'ta', telugu: 'te',
    kannada: 'kn', malayalam: 'ml', sinhala: 'si', ethiopic: 'am',
  };
  if (BY_SCRIPT[script]) return { code: BY_SCRIPT[script]!, confidence: 'high' };

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

// ── Interface translation ────────────────────────────────────────────────────

/**
 * Instructions for translating the app's own screen text (labels, buttons,
 * messages) — used for the bundled dictionaries and for text translated live.
 * The input is a JSON array; the answer must be a JSON array of the same length.
 */
export function uiTranslationPrompt(code: string): string {
  const l = aiLanguage(code);
  const name = l ? `${l.name} (${l.native}), written in ${l.script}` : code;
  return [
    `You translate the screen text of a restaurant management web app (POS, kitchen display, menu, inventory, suppliers, finance, staff, reports, settings) into ${name}.`,
    'You receive a JSON array of strings. Return ONLY a JSON array of the same length, each item the translation of the item at the same position.',
    'Write natural, short wording as used in business software in that language; buttons stay short, sentences stay complete.',
    'Keep placeholders such as {0} and {1} exactly as they are, in a natural position.',
    'Keep unchanged: currency codes and symbols (Rs, PKR, USD, AED, $), units (kg, g, ml, L, pcs), email addresses, URLs, and codes such as KOT, PO, SKU, QR, PDF, CSV, AI, API, ID, POS, KDS, COGS, VAT.',
    'Keep the brand name "Automation Restaurant" unchanged. Keep people\'s and businesses\' names as they are.',
    'Translate food and ingredient words naturally (for example Chicken, Burger, Fries are written the way they are commonly written in that language).',
    'Never add quotes, notes or explanations. If an item is already in the target language or is only a code, return it unchanged.',
  ].join('\n');
}

/** Placeholders {0}, {1} … kept, so a translation can be filled in safely. */
export function samePlaceholders(source: string, translated: string): boolean {
  const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');
  return ph(source) === ph(translated);
}

// Letters of each script a translation may legitimately contain (Latin, digits
// and punctuation are always allowed: codes, units, brand names).
const SCRIPT_OF: Record<string, RegExp> = {
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/,
  devanagari: /[ऀ-ॿ]/,
  bengali: /[ঀ-৿]/,
  gurmukhi: /[਀-੿]/,
  han: /[㐀-䶿一-鿿　-〿＀-￯]/,
  cyrillic: /[Ѐ-ӿ]/,
  greek: /[Ͱ-Ͽ]/,
  hebrew: /[֐-׿]/,
  thai: /[฀-๿]/,
  tamil: /[\u0B80-\u0BFF]/,
  kana: /[\u3040-\u30FF]/,
  hangul: /[\uAC00-\uD7AF\u1100-\u11FF]/,
  gujarati: /[\u0A80-\u0AFF]/,
  telugu: /[\u0C00-\u0C7F]/,
  kannada: /[\u0C80-\u0CFF]/,
  malayalam: /[\u0D00-\u0D7F]/,
  sinhala: /[\u0D80-\u0DFF]/,
  ethiopic: /[\u1200-\u137F]/,
};
const LANG_SCRIPT: Record<string, string[]> = {
  ur: ['arabic'], ar: ['arabic'], fa: ['arabic'], ps: ['arabic'], sd: ['arabic'],
  hi: ['devanagari'], mr: ['devanagari'], ne: ['devanagari'], bn: ['bengali'], pa: ['gurmukhi'], gu: ['gujarati'],
  ta: ['tamil'], te: ['telugu'], kn: ['kannada'], ml: ['malayalam'], si: ['sinhala'], th: ['thai'], am: ['ethiopic'],
  zh: ['han'], ja: ['han', 'kana'], ko: ['hangul', 'han'], ru: ['cyrillic'], uk: ['cyrillic'], kk: ['cyrillic'],
  el: ['greek'], he: ['hebrew'],
};

/** False when a translation contains letters of a script the language doesn't use (a model slip, e.g. Bengali inside Urdu). */
export function fitsLanguageScript(code: string, text: string): boolean {
  const own = LANG_SCRIPT[code] ?? [];
  return Object.entries(SCRIPT_OF).every(([script, re]) => own.includes(script) || !re.test(text));
}
