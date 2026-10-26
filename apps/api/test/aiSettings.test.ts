// Run: npm test -w @automation-restaurant/api   (node:test via tsx, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowToOverride, overrideToRow, isMissingTable } from '../src/lib/aiModuleSettings';

test('a stored row becomes a clean override (NULL = inherit)', () => {
  const o = rowToOverride({
    module: 'inventory',
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    input_language: null,
    response_language: 'ur',
    auto_detect: null,
    voice_input: false,
    voice_output: null,
    voice_name: null,
  });
  assert.deepEqual(o, { provider: 'gemini', model: 'gemini-3.5-flash', responseLanguage: 'ur', voiceInput: false });
});

test('unknown values in a row are dropped, not trusted', () => {
  const o = rowToOverride({ module: 'pos', provider: 'openai', response_language: 'xx', voice_input: true } as never);
  assert.deepEqual(o, { responseLanguage: 'auto', voiceInput: true });
});

test('an override round-trips through a row', () => {
  const o = { provider: 'gemini' as const, responseLanguage: 'en', autoDetect: false, voiceOutput: true, voiceName: 'Microsoft Zira' };
  const row = overrideToRow('finance', o, '00000000-0000-0000-0000-000000000001');
  assert.equal(row.module, 'finance');
  assert.equal(row.model, null);
  assert.equal(row.input_language, null);
  assert.equal(row.updated_by, '00000000-0000-0000-0000-000000000001');
  assert.deepEqual(rowToOverride(row), o);
});

test('a missing settings table is recognised (migration not applied yet)', () => {
  assert.ok(isMissingTable({ code: '42P01', message: 'relation "public.ai_module_settings" does not exist' }));
  assert.ok(isMissingTable({ code: 'PGRST205', message: "Could not find the table 'public.ai_module_settings'" }));
  assert.ok(!isMissingTable({ code: '42501', message: 'permission denied' }));
  assert.ok(!isMissingTable(null));
});
