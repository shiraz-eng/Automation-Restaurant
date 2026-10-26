import { env, aiProvider } from '../env';
import { GEMINI_CHAT_MODELS } from './geminiStream';
import type { AiModuleSettings, AiProviderId } from '@automation-restaurant/shared';

/**
 * The AI providers and models this server can actually use. A provider is
 * "configured" when its key is set (server-side only — keys never leave this
 * process); its models are the ones the provider's own model list returns
 * for that key, checked live and cached for a few minutes. Nothing is shown
 * as selectable because it appears in a list here: a model is available
 * only when the provider confirmed it.
 */
export type RegistryModel = { id: string; label: string; available: boolean };
export type RegistryProvider = {
  id: AiProviderId;
  label: string;
  configured: boolean;
  /** The live model list was fetched (false = could not check; only 'auto' can be chosen). */
  verified: boolean;
  models: RegistryModel[];
  note?: string;
};

const CACHE_MS = 10 * 60_000;
const cache = new Map<AiProviderId, { at: number; value: RegistryProvider }>();

// Shown first, in this order, when the provider lists them.
const PREFERRED: Record<AiProviderId, string[]> = {
  gemini: [...GEMINI_CHAT_MODELS],
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', env.AI_MODEL],
};

// Gemini's list includes embedding, image, speech and live-audio models; only
// text chat models that support tool calls belong in a chat model picker.
const GEMINI_EXCLUDE = /(embedding|imagen|image|tts|audio|live|native|robotics|computer-use|aqa|veo|learnlm|gemma)/i;

function order(provider: AiProviderId, ids: string[]): string[] {
  const pref = PREFERRED[provider];
  return [...ids].sort((a, b) => {
    const ia = pref.indexOf(a);
    const ib = pref.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e3 : ia) - (ib === -1 ? 1e3 : ib);
    return b.localeCompare(a);
  });
}

async function fetchGemini(): Promise<RegistryProvider> {
  const base: RegistryProvider = { id: 'gemini', label: 'Google Gemini', configured: Boolean(env.GEMINI_API_KEY), verified: false, models: [] };
  if (!base.configured) return { ...base, note: 'Set GEMINI_API_KEY on the API server to use Gemini.' };
  try {
    const found = new Map<string, string>();
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const res = await fetch(url, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY as string }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`gemini models ${res.status}`);
      const j = (await res.json()) as { models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
      for (const m of j.models ?? []) {
        const id = (m.name ?? '').replace(/^models\//, '');
        if (!id.startsWith('gemini-') || GEMINI_EXCLUDE.test(id)) continue;
        if (!(m.supportedGenerationMethods ?? []).includes('generateContent')) continue;
        found.set(id, m.displayName || id);
      }
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    const ids = order('gemini', [...found.keys()]).slice(0, 24);
    return { ...base, verified: true, models: ids.map((id) => ({ id, label: found.get(id) ?? id, available: true })) };
  } catch {
    return { ...base, note: 'Could not reach Google to check which models this key can use. Only automatic selection is offered until it can.' };
  }
}

async function fetchAnthropic(): Promise<RegistryProvider> {
  const base: RegistryProvider = { id: 'anthropic', label: 'Anthropic Claude', configured: Boolean(env.ANTHROPIC_API_KEY), verified: false, models: [] };
  if (!base.configured) return { ...base, note: 'Set ANTHROPIC_API_KEY on the API server to use Claude.' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`anthropic models ${res.status}`);
    const j = (await res.json()) as { data?: { id?: string; display_name?: string }[] };
    const found = new Map((j.data ?? []).filter((m) => m.id?.startsWith('claude-')).map((m) => [m.id!, m.display_name || m.id!]));
    const ids = order('anthropic', [...found.keys()]).slice(0, 24);
    return { ...base, verified: true, models: ids.map((id) => ({ id, label: found.get(id) ?? id, available: true })) };
  } catch {
    return { ...base, note: 'Could not reach Anthropic to check which models this key can use. Only automatic selection is offered until it can.' };
  }
}

export async function aiRegistry(force = false): Promise<RegistryProvider[]> {
  const now = Date.now();
  const get = async (id: AiProviderId, load: () => Promise<RegistryProvider>) => {
    const hit = cache.get(id);
    if (!force && hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await load();
    // A failed check is retried sooner than a good one is refreshed.
    cache.set(id, { at: value.verified || !value.configured ? now : now - CACHE_MS + 60_000, value });
    return value;
  };
  return Promise.all([get('gemini', fetchGemini), get('anthropic', fetchAnthropic)]);
}

/** Why a provider/model choice can't be saved, or null when it can. */
export async function validateModelChoice(provider: AiModuleSettings['provider'] | undefined, model: string | undefined): Promise<string | null> {
  if (provider === undefined && model === undefined) return null;
  const reg = await aiRegistry();
  const p = provider && provider !== 'auto' ? reg.find((r) => r.id === provider) : undefined;
  if (provider && provider !== 'auto') {
    if (!p) return 'Unknown AI provider.';
    if (!p.configured) return `${p.label} is not set up on this server.`;
  }
  if (!model || model === 'auto') return null;
  if (!p) return 'Choose a provider before choosing a specific model.';
  if (!p.verified) return `${p.label}'s model list could not be checked right now — keep "Automatic" or try again shortly.`;
  if (!p.models.some((m) => m.id === model && m.available)) return `${model} is not available to this server's ${p.label} key.`;
  return null;
}

/**
 * The provider and model a chat in this module should use. Falls back to the
 * server default whenever the saved choice is not usable any more (a key was
 * removed, a model retired) — an answer from the default model beats no answer.
 */
export function chatTarget(settings: Pick<AiModuleSettings, 'provider' | 'model'>): { provider: AiProviderId; model: string | null } | null {
  if (!aiProvider) return null;
  const wanted = settings.provider === 'auto' ? aiProvider : settings.provider;
  const usable = wanted === 'gemini' ? Boolean(env.GEMINI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY);
  const provider = usable ? wanted : aiProvider;
  let model = settings.model && settings.model !== 'auto' && provider === wanted ? settings.model : null;
  const listed = cache.get(provider)?.value;
  if (model && listed?.verified && !listed.models.some((m) => m.id === model)) model = null;
  return { provider, model };
}
