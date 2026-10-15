// Authorization + idempotency checks for independent branches
// (routes/ownerBranches.ts + lib/branchTenants.ts), run in-process against an
// in-memory control plane: no real project is created, nothing is written anywhere.
//   npx tsx scripts/test-owner-branches.ts
/* eslint-disable @typescript-eslint/no-require-imports */
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request, Response, NextFunction } from 'express';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { tenants: [], subscriptions: [] };
const state = { limit: 'Unlimited', connected: true, advanceTo: 'provisioning' as string, raceOnInsert: false };
let seq = 0;

// ── A tiny stand-in for the control-plane client (only what branchTenants uses) ──
class Query implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: [string, unknown][] = [];
  private op: 'select' | 'insert' | 'update' = 'select';
  private payload: Row | null = null;
  private one: 'many' | 'maybe' | 'single' = 'many';
  constructor(private table: string) {}
  select() { return this; }
  eq(k: string, v: unknown) { this.filters.push([k, v]); return this; }
  order() { return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  maybeSingle() { this.one = 'maybe'; return this.run(); }
  single() { this.one = 'single'; return this.run(); }
  then<A, B>(ok?: ((v: { data: unknown; error: { message: string } | null }) => A) | null, bad?: ((e: unknown) => B) | null) {
    return this.run().then(ok, bad);
  }
  private async run(): Promise<{ data: unknown; error: { message: string } | null }> {
    const rows = (db[this.table] ??= []);
    const match = (r: Row) => this.filters.every(([k, v]) => r[k] === v);
    if (this.op === 'insert') {
      const row: Row = { id: `id-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), provisioning_error: null, branch_seed_error: null, ...this.payload };
      if (this.table === 'tenants') {
        if (state.raceOnInsert) {
          // Another request for the same code got in first.
          state.raceOnInsert = false;
          rows.push({ ...row, id: `id-${++seq}`, slug: `${row.slug}-other` });
        }
        const dup = rows.some((r) => r.slug === row.slug || (r.parent_tenant_id && r.parent_tenant_id === row.parent_tenant_id && r.branch_code === row.branch_code));
        if (dup) return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(row);
      return { data: { ...row }, error: null };
    }
    if (this.op === 'update') {
      rows.filter(match).forEach((r) => Object.assign(r, this.payload));
      return { data: null, error: null };
    }
    const found = rows.filter(match).map((r) => ({ ...r }));
    if (this.one === 'many') return { data: found, error: null };
    return { data: found[0] ?? null, error: null };
  }
}

// ── Stub every module that would touch a real database or project ──
function stub(rel: string, exports: Record<string, unknown>) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeJS.Module;
}
stub('../src/supabase', { supabaseAdmin: { from: (t: string) => new Query(t) } });
stub('../src/mgmt', { mgmtClient: () => ({ runSql: async () => [] }) });
stub('../src/provisioning', {
  advanceProvisioning: async (slug: string) => {
    const t = db.tenants.find((r) => r.slug === slug)!;
    t.status = state.advanceTo;
  },
});
stub('../src/lib/plans', { getPlanByTier: async () => ({ limits: { branches: state.limit } }) });
stub('../src/lib/supabaseOAuth', { hasConnection: async () => state.connected, getFreshConnection: async () => ({ access_token: 'x' }) });
stub('../src/lib/tenantAdmin', {
  resolveTenantClient: async (slug: string) => ({
    ok: true,
    client: {
      admin: {
        rpc: async () => ({ data: [{ orders_count: slug.length, net_sales_cents: 1000, cogs_cents: 300 }], error: null }),
        auth: { admin: { generateLink: async ({ email }: { email: string }) => ({ data: { properties: { hashed_token: `tok:${slug}:${email}` } }, error: null }) } },
      },
    },
  }),
});
stub('../src/env', { isAllowedOrigin: () => false });
// The caller, as requirePortalPerm would resolve it from the token — here from a test header.
stub('../src/middleware/portalAuth', {
  requirePortalPerm: (need: string) => (req: Request, res: Response, next: NextFunction) => {
    const a = JSON.parse(String(req.headers['x-test-actor'] ?? '{}')) as { slug: string; role: string; permissions: string[]; email?: string };
    const slug = String((req.body as { slug?: string } | undefined)?.slug ?? req.query.slug ?? '');
    if (!(a.permissions.includes('*') || a.permissions.includes(need))) return res.status(403).json({ error: 'forbidden' });
    req.tenant = { slug, role: a.role, permissions: a.permissions, email: a.email ?? null } as unknown as Request['tenant'];
    next();
  },
});

const express = require('express') as typeof import('express');
const { ownerBranchesRouter } = require('../src/routes/ownerBranches') as typeof import('../src/routes/ownerBranches');
const { createBranch, listBranches } = require('../src/lib/branchTenants') as typeof import('../src/lib/branchTenants');

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}`}`);
}

const OWNER = { role: 'owner', permissions: ['*'], email: 'owner@example.test' };
function tenant(row: Row): Row {
  const r: Row = {
    id: `id-${++seq}`, status: 'active', owner_email: 'owner@example.test', owner_name: 'Owner', region: 'ap-south-1',
    parent_tenant_id: null, branch_code: null, branch_seed_status: null, branch_seed_error: null, provisioning_error: null,
    created_at: new Date(Date.now() + seq).toISOString(), ...row,
  };
  db.tenants.push(r);
  return r;
}

async function main() {
  const main = tenant({ slug: 'grill-house', restaurant_name: 'Grill House' });
  const other = tenant({ slug: 'other-diner', restaurant_name: 'Other Diner', owner_email: 'someone@example.test' });
  db.subscriptions.push({ tenant_id: main.id, tier: 'enterprise', billing_interval: 'month', status: 'active', current_period_end: null });
  const otherBranch = tenant({ slug: 'other-diner-x1', restaurant_name: 'Other Diner — X1', parent_tenant_id: other.id, branch_code: 'X1', branch_seed_status: 'done', owner_email: 'someone@example.test' });

  const app = express();
  app.use('/api/owner-branches', ownerBranchesRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/owner-branches`;
  const call = async (method: string, p: string, actor: object, body?: object) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-actor': JSON.stringify(actor) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };

  // ── Authorization ──
  let r = await call('GET', '/?slug=grill-house', { role: 'manager', permissions: ['branches.view'] });
  check('A1 a manager (not the owner) cannot open the owner panel', r.status === 403, r);
  r = await call('POST', '/', { role: 'manager', permissions: ['branches.view'] }, { slug: 'grill-house', code: 'DHA', name: 'DHA' });
  check('A2 creating a branch needs branches.manage', r.status === 403, r);
  r = await call('POST', '/', { role: 'manager', permissions: ['branches.view', 'branches.manage'] }, { slug: 'grill-house', code: 'DHA', name: 'DHA' });
  check('A3 branches.manage alone is not enough — owner only', r.status === 403, r);
  check('A3b … and nothing was created', db.tenants.filter((t) => t.parent_tenant_id === main.id).length === 0);
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'd', name: 'DHA' });
  check('A4 a too-short code is refused', r.status === 422, r);
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'DH A!', name: 'DHA' });
  check('A5 a code with spaces/symbols is refused', r.status === 400 && r.body.error === 'bad_code', r);

  // ── Create + idempotency ──
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'dha', name: 'DHA Phase 6' });
  check('I1 the owner creates a branch: 202, still being set up', r.status === 202 && r.body.branch.status === 'provisioning' && r.body.existed === false, r);
  const dha = r.body.branch as { id: string; slug: string; code: string; name: string };
  check('I2 its own restaurant: slug grill-house-dha, code DHA, owner\'s name prefix', dha.slug === 'grill-house-dha' && dha.code === 'DHA' && dha.name === 'Grill House — DHA Phase 6', dha);
  check('I3 it runs on the main restaurant\'s plan', db.subscriptions.some((s) => s.tenant_id === dha.id && s.tier === 'enterprise'));
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'DHA', name: 'Again' });
  check('I4 the same code again returns the same branch (200), no second project', r.status === 200 && r.body.existed === true && r.body.branch.id === dha.id, r);
  check('I5 still exactly one DHA row', db.tenants.filter((t) => t.parent_tenant_id === main.id && t.branch_code === 'DHA').length === 1);
  state.raceOnInsert = true;
  const raced = await createBranch(main as never, { code: 'CLF', name: 'Clifton' }).catch((e: Error) => e);
  check('I6 two creates racing on one code: the loser gets the winner\'s branch', !(raced instanceof Error) && raced.existed === true, raced);
  check('I7 … and there is still one CLF row', db.tenants.filter((t) => t.parent_tenant_id === main.id && t.branch_code === 'CLF').length === 1);

  // ── Never "created" until provisioning finishes ──
  r = await call('POST', `/${dha.id}/advance`, OWNER, { slug: 'grill-house' });
  check('P1 advance while setup runs: still provisioning', r.status === 200 && r.body.branch.status === 'provisioning', r);
  state.advanceTo = 'failed';
  r = await call('POST', `/${dha.id}/advance`, OWNER, { slug: 'grill-house' });
  check('P2 a failed setup is reported as failed, not created', r.body.branch.status === 'failed', r);
  r = await call('GET', '/?slug=grill-house', OWNER);
  const listed = (r.body.branches ?? []) as { id: string; metrics: unknown; status: string }[];
  check('P3 the panel shows the failed branch with no figures', listed.find((b) => b.id === dha.id)?.metrics === null && listed.find((b) => b.id === dha.id)?.status === 'failed', listed);
  r = await call('POST', `/${dha.id}/open`, OWNER, { slug: 'grill-house' });
  check('P4 a branch that isn\'t ready cannot be opened', r.status === 409, r);
  state.advanceTo = 'active';
  db.tenants.find((t) => t.id === dha.id)!.branch_seed_status = 'done'; // the copy itself is rehearsed in test-branch-seed.ts
  r = await call('POST', `/${dha.id}/retry`, OWNER, { slug: 'grill-house' });
  check('P5 retry resumes setup and the branch becomes active', r.status === 200 && r.body.branch.status === 'active', r);

  // ── Isolation between restaurants ──
  r = await call('GET', '/?slug=grill-house', OWNER);
  const ids = ((r.body.branches ?? []) as { id: string }[]).map((b) => b.id);
  check('S1 the owner sees only their own branches', ids.includes(dha.id) && !ids.includes(otherBranch.id as string), ids);
  check('S2 each branch\'s figures come from its own database', (r.body.branches as { id: string; metrics: { orders: number } | null }[]).find((b) => b.id === dha.id)?.metrics?.orders === 'grill-house-dha'.length, r.body);
  r = await call('POST', `/${otherBranch.id}/advance`, OWNER, { slug: 'grill-house' });
  check('S3 another restaurant\'s branch id is not found (404)', r.status === 404, r);
  r = await call('POST', `/${otherBranch.id}/open`, OWNER, { slug: 'grill-house' });
  check('S4 … nor can it be opened', r.status === 404, r);
  r = await call('POST', '/', OWNER, { slug: 'grill-house-dha', code: 'SUB', name: 'Sub-branch' });
  check('S5 a branch workspace cannot create branches', r.status === 403, r);
  r = await call('GET', '/?slug=grill-house-dha', OWNER);
  check('S6 a branch workspace has no owner panel', r.status === 403, r);

  // ── Opening a branch workspace ──
  r = await call('POST', `/${dha.id}/open`, { role: 'admin', permissions: ['*'], email: 'admin@example.test' }, { slug: 'grill-house' });
  check('O1 a delegated * login cannot sign in as the owner of a branch', r.status === 403, r);
  r = await call('POST', `/${dha.id}/open`, { ...OWNER, email: 'impostor@example.test' }, { slug: 'grill-house' });
  check('O2 an owner-role login with another e-mail cannot either', r.status === 403, r);
  r = await call('POST', `/${dha.id}/open`, { ...OWNER, email: 'OWNER@example.test' }, { slug: 'grill-house' });
  check('O3 the restaurant owner gets a one-time sign-in for that branch only', r.status === 200 && r.body.slug === 'grill-house-dha' && r.body.token === 'tok:grill-house-dha:owner@example.test', r);

  // ── Plan limits and the Supabase connection ──
  state.limit = '2';
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'GUL', name: 'Gulshan' });
  check('L1 the plan\'s location limit is enforced (main + 2 branches = 3 > 2)', r.status === 403 && r.body.error === 'branch_limit', r);
  state.limit = 'Unlimited';
  state.connected = false;
  const before = db.tenants.length;
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'GUL', name: 'Gulshan' });
  check('L2 without a Supabase connection: 409, and no row is written', r.status === 409 && r.body.error === 'not_connected' && db.tenants.length === before, r);
  state.connected = true;
  main.status = 'suspended';
  r = await call('POST', '/', OWNER, { slug: 'grill-house', code: 'GUL', name: 'Gulshan' });
  check('L3 a suspended main restaurant cannot add branches', r.status === 400 && r.body.error === 'parent_not_active', r);
  main.status = 'active';
  check('L4 the main restaurant stays a normal restaurant (no parent)', main.parent_tenant_id === null && (await listBranches(main.id as string)).length === 2);

  server.close();
  console.log(`\n${fails} failed`);
  process.exit(fails ? 1 : 0);
}
void main();
