import type { SupabaseClient } from '@supabase/supabase-js';
import {
  resolveAiSettings,
  sanitizeAiOverride,
  type AiModuleKey,
  type AiModuleOverride,
  type AiModuleSettings,
} from '@automation-restaurant/shared';

/**
 * Reads and writes public.ai_module_settings (tenant-migrations/0108).
 * A restaurant whose database doesn't have the table yet simply gets the
 * built-in defaults — the assistant must keep working while a migration
 * is pending.
 */

type Row = {
  module: string;
  provider: string | null;
  model: string | null;
  input_language: string | null;
  response_language: string | null;
  auto_detect: boolean | null;
  voice_input: boolean | null;
  voice_output: boolean | null;
  voice_name: string | null;
  updated_at?: string;
};

const COLUMNS = 'module, provider, model, input_language, response_language, auto_detect, voice_input, voice_output, voice_name, updated_at';

export function rowToOverride(r: Partial<Row> | null | undefined): AiModuleOverride {
  if (!r) return {};
  return sanitizeAiOverride({
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    inputLanguage: r.input_language ?? undefined,
    responseLanguage: r.response_language ?? undefined,
    autoDetect: r.auto_detect ?? undefined,
    voiceInput: r.voice_input ?? undefined,
    voiceOutput: r.voice_output ?? undefined,
    voiceName: r.voice_name ?? undefined,
  });
}

export function overrideToRow(module: AiModuleKey, o: AiModuleOverride, userId: string | null): Row & { updated_by: string | null; updated_at: string } {
  return {
    module,
    provider: o.provider ?? null,
    model: o.model ?? null,
    input_language: o.inputLanguage ?? null,
    response_language: o.responseLanguage ?? null,
    auto_detect: o.autoDetect ?? null,
    voice_input: o.voiceInput ?? null,
    voice_output: o.voiceOutput ?? null,
    voice_name: o.voiceName ?? null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
}

/** The table is missing (migration 0108 not applied yet) rather than a real failure. */
export function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  return !!err && (err.code === '42P01' || err.code === 'PGRST205' || /ai_module_settings/.test(err.message ?? ''));
}

export type StoredAiSettings = {
  /** false = the table isn't there yet; everything is the built-in default. */
  stored: boolean;
  overrides: Partial<Record<AiModuleKey, AiModuleOverride>>;
};

export async function loadAllAiOverrides(admin: SupabaseClient): Promise<StoredAiSettings> {
  const { data, error } = await admin.from('ai_module_settings').select(COLUMNS);
  if (error) {
    if (!isMissingTable(error)) console.warn('[ai] module settings read failed:', error.message);
    return { stored: false, overrides: {} };
  }
  const overrides: StoredAiSettings['overrides'] = {};
  for (const r of (data ?? []) as Row[]) overrides[r.module as AiModuleKey] = rowToOverride(r);
  return { stored: true, overrides };
}

/** The effective settings for one module (its override over the restaurant default). */
export async function loadAiSettings(admin: SupabaseClient, module: AiModuleKey): Promise<AiModuleSettings> {
  const { data, error } = await admin
    .from('ai_module_settings')
    .select(COLUMNS)
    .in('module', module === 'global' ? ['global'] : ['global', module]);
  if (error) {
    if (!isMissingTable(error)) console.warn('[ai] module settings read failed:', error.message);
    return resolveAiSettings(null, null);
  }
  const rows = (data ?? []) as Row[];
  return resolveAiSettings(rowToOverride(rows.find((r) => r.module === 'global')), module === 'global' ? null : rowToOverride(rows.find((r) => r.module === module)));
}
