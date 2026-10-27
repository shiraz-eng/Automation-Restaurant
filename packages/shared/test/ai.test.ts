// Run: npm test -w @automation-restaurant/shared   (node:test via tsx, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage,
  languageInstruction,
  fitsLanguageScript,
  samePlaceholders,
  normalizeLanguageChoice,
  isRtlLanguage,
  resolveResponseLanguage,
} from '../src/aiLanguages';
import {
  aiModuleForPath,
  effectiveResponseLanguage,
  resolveAiSettings,
  sanitizeAiOverride,
  DEFAULT_AI_SETTINGS,
} from '../src/aiConfig';

test('detects Urdu script, including short questions', () => {
  assert.equal(detectLanguage('آج کتنا اسٹاک باقی ہے؟')?.code, 'ur');
  assert.equal(detectLanguage('کیا چکن ختم ہو گیا')?.code, 'ur');
  assert.equal(detectLanguage('کم اسٹاک والی اشیاء دکھائیں')?.code, 'ur');
});

test('tells Arabic, Persian and Pashto apart from Urdu', () => {
  assert.equal(detectLanguage('كم عدد الطلبات اليوم؟')?.code, 'ar');
  assert.equal(detectLanguage('موجودی انبار چقدر است')?.code, 'fa');
  assert.equal(detectLanguage('نن ورځ څومره خرڅلاو شو')?.code, 'ps');
});

test('detects Hindi, Bengali, Punjabi and Chinese by script', () => {
  assert.equal(detectLanguage('आज कितना स्टॉक बचा है?')?.code, 'hi');
  assert.equal(detectLanguage('আজ কত বিক্রি হয়েছে')?.code, 'bn');
  assert.equal(detectLanguage('ਅੱਜ ਕਿੰਨੀ ਵਿਕਰੀ ਹੋਈ')?.code, 'pa');
  assert.equal(detectLanguage('今天的销售额是多少')?.code, 'zh');
});

test('detects Roman Urdu without mistaking English for it', () => {
  assert.equal(detectLanguage('aaj kitna stock bacha hai?')?.code, 'ur-Latn');
  assert.equal(detectLanguage('mujhe low stock items batao')?.code, 'ur-Latn');
  assert.equal(detectLanguage('stock update kar do')?.code, 'ur-Latn');
  assert.equal(detectLanguage('Please do update the stock')?.code, 'en');
  assert.equal(detectLanguage('How much chicken is left in stock today?')?.code, 'en');
  assert.equal(detectLanguage('Show me the menu for the weekend')?.code, 'en');
  assert.equal(detectLanguage('What is the ledger?')?.code, 'en');
});

test('detects common European languages', () => {
  assert.equal(detectLanguage('combien de commandes est-ce que nous avons pour le dîner')?.code, 'fr');
  assert.equal(detectLanguage('cuánto stock hay en la cocina para hoy')?.code, 'es');
});

test('returns null when there is nothing to go on', () => {
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('1234 ?!'), null);
});

test('RTL is only Urdu, Arabic, Persian and Pashto', () => {
  assert.ok(isRtlLanguage('ur') && isRtlLanguage('ar') && isRtlLanguage('fa') && isRtlLanguage('ps'));
  assert.ok(!isRtlLanguage('ur-Latn') && !isRtlLanguage('hi') && !isRtlLanguage('en') && !isRtlLanguage(undefined));
});

test('unknown language choices fall back to auto', () => {
  assert.equal(normalizeLanguageChoice('xx'), 'auto');
  assert.equal(normalizeLanguageChoice(42), 'auto');
  assert.equal(normalizeLanguageChoice('ur'), 'ur');
});

test('explicit response language wins over the message language', () => {
  assert.equal(resolveResponseLanguage('en', 'آج کتنا اسٹاک باقی ہے؟'), 'en');
  assert.equal(resolveResponseLanguage('auto', 'آج کتنا اسٹاک باقی ہے؟'), 'ur');
  assert.equal(resolveResponseLanguage(undefined, 'hello there friend'), 'en');
});

test('prompt instruction names the fixed language and keeps figures intact', () => {
  const fixed = languageInstruction('en', 'آج کتنا اسٹاک باقی ہے؟');
  assert.match(fixed, /Always write your reply in English/);
  assert.match(fixed, /looks like Urdu/);
  assert.match(fixed, /never convert currencies/);
  const auto = languageInstruction('auto', 'آج کتنا اسٹاک باقی ہے؟');
  assert.match(auto, /same language and script/);
  assert.match(auto, /looks like Urdu/);
});

test('module settings inherit global, then built-in defaults', () => {
  const s = resolveAiSettings({ responseLanguage: 'ur', voiceOutput: false }, { voiceOutput: true, inputLanguage: 'ur' });
  assert.equal(s.responseLanguage, 'ur');
  assert.equal(s.voiceOutput, true);
  assert.equal(s.inputLanguage, 'ur');
  assert.equal(s.autoDetect, DEFAULT_AI_SETTINGS.autoDetect);
  assert.deepEqual(resolveAiSettings(null, null), DEFAULT_AI_SETTINGS);
});

test('sanitizing drops unknown or unsafe values', () => {
  const o = sanitizeAiOverride({ provider: 'openai', model: 'x; drop table', responseLanguage: 'klingon', voiceInput: 'yes', voiceName: '  Microsoft Asad  ', extra: 1 });
  assert.deepEqual(o, { responseLanguage: 'auto', voiceName: 'Microsoft Asad' });
  assert.deepEqual(sanitizeAiOverride(null), {});
});

test('response language: device choice, then module setting, then detection', () => {
  const auto = { responseLanguage: 'auto', inputLanguage: 'auto', autoDetect: true } as const;
  assert.equal(effectiveResponseLanguage('auto', auto, 'آج کتنا اسٹاک باقی ہے؟'), 'ur');
  assert.equal(effectiveResponseLanguage('en', auto, 'آج کتنا اسٹاک باقی ہے؟'), 'en');
  assert.equal(effectiveResponseLanguage('auto', { ...auto, responseLanguage: 'ar' }, 'stock?'), 'ar');
  assert.equal(effectiveResponseLanguage('auto', { ...auto, autoDetect: false, inputLanguage: 'hi' }, 'آج کتنا'), 'hi');
  assert.equal(effectiveResponseLanguage('auto', { ...auto, autoDetect: false }, 'آج کتنا'), 'en');
});

test('paths map to the module that owns the screen', () => {
  assert.equal(aiModuleForPath('/r/bbq/inventory'), 'inventory');
  assert.equal(aiModuleForPath('/r/bbq/menu/priority'), 'inventory');
  assert.equal(aiModuleForPath('/r/bbq/menu'), 'menu');
  assert.equal(aiModuleForPath('/r/bbq/checkout?table=3'), 'pos');
  assert.equal(aiModuleForPath('/r/bbq/kds/history'), 'kitchen');
  assert.equal(aiModuleForPath('/r/bbq/purchasing'), 'suppliers');
  assert.equal(aiModuleForPath('/r/bbq/finance/ledger'), 'finance');
  assert.equal(aiModuleForPath('/r/bbq'), 'manager');
  assert.equal(aiModuleForPath('/r/bbq/settings/tax'), 'admin');
  assert.equal(aiModuleForPath('/r/bbq/modules/analytics'), 'manager');
  assert.equal(aiModuleForPath('/r/bbq/ai'), 'global');
  assert.equal(aiModuleForPath('/order/bbq'), 'customer');
  assert.equal(aiModuleForPath('/pricing'), 'global');
});

test('screen translations keep placeholders and their own script', () => {
  assert.ok(samePlaceholders('{0} of {1} items', '{1} میں سے {0} اشیاء'));
  assert.ok(!samePlaceholders('{0} of {1} items', 'کچھ اشیاء'));
  assert.ok(fitsLanguageScript('ur', 'POS اور آرڈرز'));
  assert.ok(!fitsLanguageScript('ur', 'اونر প্যানেল'));
  assert.ok(fitsLanguageScript('hi', 'स्टॉक (kg)'));
  assert.ok(!fitsLanguageScript('fr', 'Stock اسٹاک'));
});
