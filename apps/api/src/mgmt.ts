import { env } from './env';

/**
 * Thin client for the Supabase Management API (https://api.supabase.com).
 * Used to create and configure a dedicated project per restaurant.
 */
const BASE = 'https://api.supabase.com/v1';

async function mgmt<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Management API ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatedProject {
  id: string; // project ref
  name: string;
  region: string;
  status: string;
}

export function createProject(name: string, dbPass: string): Promise<CreatedProject> {
  return mgmt<CreatedProject>('/projects', {
    method: 'POST',
    body: JSON.stringify({
      organization_id: env.SUPABASE_ORG_ID,
      name,
      region: env.SUPABASE_REGION,
      db_pass: dbPass,
      plan: env.SUPABASE_PROJECT_PLAN,
    }),
  });
}

export function getProject(ref: string): Promise<{ status: string }> {
  return mgmt<{ status: string }>(`/projects/${ref}`);
}

export async function waitForActive(ref: string, timeoutMs = 6 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status } = await getProject(ref);
    if (status === 'ACTIVE_HEALTHY') return;
    if (status === 'INACTIVE' || status.includes('FAILED')) {
      throw new Error(`project ${ref} entered status ${status}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`project ${ref} not ACTIVE_HEALTHY within ${timeoutMs}ms`);
}

export async function getApiKeys(ref: string): Promise<{ anon: string; service_role: string }> {
  const keys = await mgmt<{ name: string; api_key: string }[]>(`/projects/${ref}/api-keys`);
  const find = (n: string) => keys.find((k) => k.name === n)?.api_key;
  const anon = find('anon');
  const service_role = find('service_role');
  if (!anon || !service_role) throw new Error(`missing api keys for ${ref}`);
  return { anon, service_role };
}

/** Run arbitrary SQL against a project's database. */
export async function runSql(ref: string, query: string): Promise<unknown> {
  return mgmt<unknown>(`/projects/${ref}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}
