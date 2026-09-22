import { env } from './env';

/**
 * Thin client for the Supabase Management API (https://api.supabase.com).
 * Used to create and configure a dedicated project per restaurant.
 *
 * `mgmtClient(token)` binds every call to one bearer token — either the
 * platform personal access token (legacy) or a per-tenant OAuth access token
 * from the "Connect your Supabase" flow.
 */
const BASE = 'https://api.supabase.com/v1';

export interface CreatedProject {
  id: string; // project ref
  name: string;
  region: string;
  status: string;
}

export interface Organization {
  id: string;
  slug?: string;
  name: string;
}

export interface MgmtClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  listOrganizations(): Promise<Organization[]>;
  createProject(input: {
    organizationId: string;
    name: string;
    dbPass: string;
    region?: string;
    plan?: 'free' | 'pro';
  }): Promise<CreatedProject>;
  getProject(ref: string): Promise<{ status: string }>;
  waitForActive(ref: string, timeoutMs?: number): Promise<void>;
  /** Ready = the new database accepts a query. Doesn't need Projects:Read. */
  waitForQueryable(ref: string, timeoutMs?: number): Promise<void>;
  getApiKeys(ref: string): Promise<{ anon: string; service_role: string }>;
  runSql(ref: string, query: string): Promise<unknown>;
  deleteProject(ref: string): Promise<void>;
}

export function mgmtClient(token: string): MgmtClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Management API ${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  const getProject = (ref: string) => request<{ status: string }>(`/projects/${ref}`);

  const client: MgmtClient = {
    request,
    listOrganizations: () => request<Organization[]>('/organizations'),
    createProject: ({ organizationId, name, dbPass, region, plan }) =>
      request<CreatedProject>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: organizationId,
          name,
          region: region ?? env.SUPABASE_REGION,
          db_pass: dbPass,
          plan: plan ?? env.SUPABASE_PROJECT_PLAN,
        }),
      }),
    getProject,
    async waitForActive(ref, timeoutMs = 6 * 60_000) {
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
    },
    async waitForQueryable(ref, timeoutMs = 8 * 60_000) {
      const deadline = Date.now() + timeoutMs;
      let lastErr: unknown;
      // Fresh projects reject queries with 5xx / "not ready" for the first
      // minute or two; a clean `select 1` means Postgres + the query API are up.
      while (Date.now() < deadline) {
        try {
          await request(`/projects/${ref}/database/query`, {
            method: 'POST',
            body: JSON.stringify({ query: 'select 1;' }),
          });
          return;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 10_000));
        }
      }
      throw new Error(
        `project ${ref} not queryable within ${timeoutMs}ms (last: ${String(lastErr)})`,
      );
    },
    async getApiKeys(ref) {
      const keys = await request<{ name: string; api_key: string }[]>(
        `/projects/${ref}/api-keys`,
      );
      const find = (n: string) => keys.find((k) => k.name === n)?.api_key;
      const anon = find('anon');
      const service_role = find('service_role');
      if (!anon || !service_role) throw new Error(`missing api keys for ${ref}`);
      return { anon, service_role };
    },
    runSql: (ref, query) =>
      request<unknown>(`/projects/${ref}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query }),
      }),
    deleteProject: async (ref) => {
      await request<unknown>(`/projects/${ref}`, { method: 'DELETE' });
    },
  };
  return client;
}

/** Platform-token client (legacy "all tenants in our org" path). */
export const platformMgmt = mgmtClient(env.SUPABASE_ACCESS_TOKEN);
