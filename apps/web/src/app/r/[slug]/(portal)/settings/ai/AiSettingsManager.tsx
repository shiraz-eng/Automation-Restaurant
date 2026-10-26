'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { AI_LANGUAGES, aiLanguage, resolveAiSettings, type AiModuleKey, type AiModuleOverride, type AiModuleSettings } from '@automation-restaurant/shared';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card } from '@/components/ui';
import { clearModuleAiConfigCache } from '@/lib/ai/moduleSettings';
import { useVoices } from '@/lib/ai/speech';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type RegistryModel = { id: string; label: string; available: boolean };
type RegistryProvider = { id: 'gemini' | 'anthropic'; label: string; configured: boolean; verified: boolean; models: RegistryModel[]; note?: string };
type FullConfig = {
  stored: boolean;
  canEdit: boolean;
  overrides: Partial<Record<AiModuleKey, AiModuleOverride>>;
  modules: { key: AiModuleKey; label: string }[];
  providers: RegistryProvider[];
  defaultProvider: 'gemini' | 'anthropic' | null;
};

const INHERIT = '';

function onOff(v: boolean | undefined): string {
  return v === undefined ? INHERIT : v ? 'on' : 'off';
}
function fromOnOff(v: string): boolean | undefined {
  return v === INHERIT ? undefined : v === 'on';
}

function summary(s: AiModuleSettings, providers: RegistryProvider[], fallback: string | null): string {
  const p = s.provider === 'auto' ? providers.find((x) => x.id === fallback)?.label ?? 'Automatic' : providers.find((x) => x.id === s.provider)?.label ?? s.provider;
  const answer = s.responseLanguage === 'auto' ? (s.autoDetect ? 'match the question' : 'fixed') : aiLanguage(s.responseLanguage)?.name;
  const voice = [s.voiceInput ? 'mic on' : 'mic off', s.voiceOutput ? 'read-aloud on' : 'read-aloud off'].join(', ');
  return `${p} · ${s.model === 'auto' ? 'automatic model' : s.model} · answers: ${answer} · ${voice}`;
}

/**
 * Edits public.ai_module_settings through PUT /api/ai/config (settings.update,
 * validated against the providers this server can really reach, audited).
 * Every module shows what it inherits, so leaving a field on "Inherit" is a
 * real, visible choice rather than a blank.
 */
export function AiSettingsManager({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const supabase = usePortalSupabase();
  const [cfg, setCfg] = useState<FullConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const token = useCallback(async () => (await supabase.auth.getSession()).data.session?.access_token ?? '', [supabase]);

  const load = useCallback(
    async (refresh = false) => {
      setLoadError(null);
      setChecking(refresh);
      try {
        const res = await fetch(`${API}/api/ai/config?slug=${encodeURIComponent(slug)}&module=global&full=1${refresh ? '&refresh=1' : ''}`, {
          headers: { Authorization: `Bearer ${await token()}` },
        });
        const j = (await res.json().catch(() => ({}))) as Partial<FullConfig> & { message?: string };
        if (!res.ok) throw new Error(j.message ?? 'The AI settings could not be loaded.');
        if (!j.providers) {
          // No settings.update: the API returns only this module's effective settings.
          setCfg({ stored: true, canEdit: false, overrides: {}, modules: [], providers: [], defaultProvider: null });
          return;
        }
        setCfg(j as FullConfig);
      } catch (e) {
        setLoadError((e as Error).message);
      } finally {
        setChecking(false);
      }
    },
    [slug, token],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return (
      <Card>
        <p role="alert" className="text-danger text-xs">
          <strong>Couldn&apos;t load AI settings: </strong>
          {loadError}
        </p>
        <Button variant="ghost" className="mt-3" onClick={() => load()}>
          Try again
        </Button>
      </Card>
    );
  }
  if (!cfg) return <p className="text-muted text-xs" role="status">Loading AI settings…</p>;
  if (!cfg.providers.length) {
    return (
      <Card>
        <p className="text-xs text-muted">You can see which AI features are on, but only someone with permission to change settings can edit them.</p>
      </Card>
    );
  }

  const editable = canEdit && cfg.canEdit && cfg.stored;
  const globalEff = resolveAiSettings(cfg.overrides.global, null);

  return (
    <div className="space-y-4">
      {!cfg.stored && (
        <div role="status" className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs">
          <strong>Database update needed.</strong> This restaurant&apos;s database doesn&apos;t have the AI settings table yet
          (update 0108). Everything below shows the built-in defaults, which are in use now; saving is turned on after the update.
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-sm">AI providers on this server</h2>
            <p className="text-muted text-[0.6875rem] mt-0.5">Keys are kept on the server and never shown. Models are listed only when the provider confirms this key can use them.</p>
          </div>
          <Button variant="ghost" onClick={() => load(true)} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check models'}
          </Button>
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cfg.providers.map((p) => (
            <li key={p.id} className="rounded-lg border border-border p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{p.label}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[0.625rem] font-bold ${
                    p.configured && p.verified ? 'bg-ok/10 text-ok' : p.configured ? 'bg-warn/10 text-warn' : 'bg-main text-muted'
                  }`}
                >
                  {p.configured && p.verified ? `✓ Ready · ${p.models.length} models` : p.configured ? '! Key set, models not checked' : '— Not set up'}
                </span>
              </div>
              {p.id === cfg.defaultProvider && <p className="mt-1 text-[0.6875rem] text-muted">Used when a module is on “Automatic”.</p>}
              {p.note && <p className="mt-1 text-[0.6875rem] text-muted">{p.note}</p>}
            </li>
          ))}
        </ul>
      </Card>

      <div className="space-y-2">
        {cfg.modules.map((m) => (
          <ModuleRow
            key={m.key}
            slug={slug}
            module={m.key}
            label={m.label}
            override={cfg.overrides[m.key] ?? {}}
            inherited={m.key === 'global' ? resolveAiSettings(null, null) : globalEff}
            providers={cfg.providers}
            defaultProvider={cfg.defaultProvider}
            editable={editable}
            token={token}
            onSaved={(o) => {
              clearModuleAiConfigCache();
              setCfg((c) => (c ? { ...c, overrides: { ...c.overrides, [m.key]: o } } : c));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-[0.6875rem] font-semibold text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-primary disabled:opacity-60"
      >
        {children}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 text-[0.625rem] text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

function ModuleRow({
  slug,
  module,
  label,
  override,
  inherited,
  providers,
  defaultProvider,
  editable,
  token,
  onSaved,
}: {
  slug: string;
  module: AiModuleKey;
  label: string;
  override: AiModuleOverride;
  inherited: AiModuleSettings;
  providers: RegistryProvider[];
  defaultProvider: 'gemini' | 'anthropic' | null;
  editable: boolean;
  token: () => Promise<string>;
  onSaved: (o: AiModuleOverride) => void;
}) {
  const [draft, setDraft] = useState<AiModuleOverride>(override);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const voices = useVoices();
  const errId = useId();
  useEffect(() => setDraft(override), [override]);

  const eff = resolveAiSettings(inherited, draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(override);
  const set = (patch: Partial<Record<keyof AiModuleOverride, unknown>>) => {
    setSaved(false);
    setDraft((d) => {
      const next = { ...d, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      return next as AiModuleOverride;
    });
  };
  const inh = (txt: string) => (module === 'global' ? `Built-in default (${txt})` : `Inherit (${txt})`);
  const providerFor = eff.provider === 'auto' ? defaultProvider : eff.provider;
  const models = providers.find((p) => p.id === providerFor)?.models ?? [];

  async function save(next: AiModuleOverride | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ slug, module, override: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { override?: AiModuleOverride; message?: string };
      if (!res.ok) throw new Error(j.message ?? 'The setting could not be saved.');
      onSaved(j.override ?? {});
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const langOptions = (
    <>
      <option value="auto">Automatic</option>
      {AI_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.native === l.name ? l.name : `${l.name} — ${l.native}`}
        </option>
      ))}
    </>
  );
  const langName = (c: string) => (c === 'auto' ? 'automatic' : (aiLanguage(c)?.name ?? c));

  return (
    <details className="group rounded-lg border border-border bg-surface open:shadow-sm" open={module === 'global'}>
      <summary className="flex cursor-pointer list-none [&::-webkit-details-marker]:hidden items-center justify-between gap-2 rounded-lg px-4 py-3 hover:bg-main">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold">
            {label}
            {Object.keys(override).length > 0 && module !== 'global' && (
              <span className="ms-2 rounded-full bg-primary/10 px-2 py-0.5 text-[0.625rem] font-semibold text-primary">Customised</span>
            )}
          </span>
          <span className="block truncate text-[0.6875rem] text-muted">{summary(resolveAiSettings(inherited, override), providers, defaultProvider)}</span>
        </span>
        <span aria-hidden className="text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <SelectField
            label="AI provider"
            value={draft.provider ?? INHERIT}
            disabled={!editable}
            onChange={(v) => set({ provider: v || undefined, model: undefined })}
          >
            <option value={INHERIT}>{inh(inherited.provider === 'auto' ? 'automatic' : inherited.provider)}</option>
            <option value="auto">Automatic (server default)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {p.label}
                {p.configured ? '' : ' — not set up'}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Model"
            value={draft.model ?? INHERIT}
            disabled={!editable}
            onChange={(v) => set({ model: v || undefined })}
            hint={eff.provider === 'auto' && (draft.model ?? 'auto') === 'auto' ? 'Pick a provider to choose a specific model.' : undefined}
          >
            <option value={INHERIT}>{inh(inherited.model === 'auto' ? 'automatic' : inherited.model)}</option>
            <option value="auto">Automatic (fastest, with backups)</option>
            {eff.provider !== 'auto' &&
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                </option>
              ))}
          </SelectField>
          <SelectField label="Answer language" value={draft.responseLanguage ?? INHERIT} disabled={!editable} onChange={(v) => set({ responseLanguage: v || undefined })}>
            <option value={INHERIT}>{inh(langName(inherited.responseLanguage))}</option>
            {langOptions}
          </SelectField>
          <SelectField label="Listening language (microphone)" value={draft.inputLanguage ?? INHERIT} disabled={!editable} onChange={(v) => set({ inputLanguage: v || undefined })}>
            <option value={INHERIT}>{inh(langName(inherited.inputLanguage))}</option>
            {langOptions}
          </SelectField>
          <SelectField
            label="Detect language automatically"
            value={onOff(draft.autoDetect)}
            disabled={!editable}
            onChange={(v) => set({ autoDetect: fromOnOff(v) })}
            hint="On: an “Automatic” answer language follows each question."
          >
            <option value={INHERIT}>{inh(inherited.autoDetect ? 'on' : 'off')}</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </SelectField>
          <SelectField label="Voice input" value={onOff(draft.voiceInput)} disabled={!editable} onChange={(v) => set({ voiceInput: fromOnOff(v) })}>
            <option value={INHERIT}>{inh(inherited.voiceInput ? 'on' : 'off')}</option>
            <option value="on">On — show the microphone</option>
            <option value="off">Off</option>
          </SelectField>
          <SelectField label="Spoken answers" value={onOff(draft.voiceOutput)} disabled={!editable} onChange={(v) => set({ voiceOutput: fromOnOff(v) })}>
            <option value={INHERIT}>{inh(inherited.voiceOutput ? 'on' : 'off')}</option>
            <option value="on">On — offer read-aloud</option>
            <option value="off">Off</option>
          </SelectField>
          <SelectField
            label="Preferred voice"
            value={draft.voiceName === undefined ? INHERIT : (draft.voiceName ?? INHERIT)}
            disabled={!editable}
            onChange={(v) => set({ voiceName: v || undefined })}
            hint="Voices are installed per device; a device without this one uses its best voice for the language."
          >
            <option value={INHERIT}>{inh(inherited.voiceName ?? 'best available')}</option>
            {draft.voiceName && !voices.some((v) => v.name === draft.voiceName) && <option value={draft.voiceName}>{draft.voiceName}</option>}
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </SelectField>
        </div>
        {error && (
          <p id={errId} role="alert" className="rounded border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
            <strong>Not saved: </strong>
            {error}
          </p>
        )}
        {saved && !dirty && (
          <p role="status" className="text-xs text-ok">
            ✓ Saved. New questions in {module === 'global' ? 'every module' : label} use these settings.
          </p>
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !dirty} onClick={() => save(draft)} aria-describedby={error ? errId : undefined}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {Object.keys(override).length > 0 && (
              <Button variant="ghost" disabled={busy} onClick={() => save(null)}>
                {module === 'global' ? 'Reset to built-in defaults' : 'Reset to restaurant default'}
              </Button>
            )}
            {dirty && (
              <Button variant="ghost" disabled={busy} onClick={() => setDraft(override)}>
                Discard changes
              </Button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
