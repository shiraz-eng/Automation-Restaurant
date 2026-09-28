# Automation Restaurant — guide for Gemini (Gemini CLI / Gemini Code Assist)

Multi-tenant restaurant management SaaS. Every restaurant has its **own
Supabase project**; a central **control-plane** Supabase project is the
registry. Production runs on Vercel (projects `web` and
`automation-restaurant-api`) and deploys on every push to `main`.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 15 App Router — marketing site, platform admin (`/admin`), each restaurant's portal (`/r/<slug>`), custom portals (`/r/<slug>/portal/<key>`), guest ordering (`/order/<slug>`). |
| `apps/api` | Express 4 — onboarding/provisioning, staff, AI assistant (`src/routes/ai.ts`, tools in `src/lib/aiTools.ts`), Smart Import, cron jobs (`/api/cron/*`), Stripe webhook. |
| `packages/shared` | Plan tiers and feature entitlements used by both apps. |
| `supabase/tenant-migrations/NNNN_*.sql` | Changes to every restaurant database, applied in order. |
| `supabase/tenant-template/schema.sql` | Full schema for a NEW restaurant = all tenant migrations appended. |
| `supabase/control-plane/NNNN_*.sql` | Changes to the control-plane database. |

## How things work

- **One main portal.** Every staff login uses `/r/<slug>`; each page and nav item is gated by
  **permission** (`can()` / `gatePortalPage()` in `apps/web/src/lib/permissions.ts`), never by role
  name. Custom portals (Portal Management) give a station its own screen.
- **Staff** are records (name, typed job, shift start) with no login.
- **Security is enforced in the database** (RLS + `app.has_perm()`), not by hiding buttons.
  Never trust a role, permission, tenant or price sent by the browser.
- **Money** is stored as integer cents. **Dates** follow the restaurant's timezone
  (`business_settings.timezone`); the servers run in UTC.
- **Tax** comes from `business_settings.tax_enabled / tax_rate_bps`; `place_order()` charges it itself.
- **Net sales** = served/paid orders, before tax, minus discounts and refunds. **Net profit**
  subtracts every expense recorded up to the end of the period.

## Making a database change

1. Add `supabase/tenant-migrations/NNNN_description.sql` (next number, idempotent SQL).
2. Append the same SQL to `supabase/tenant-template/schema.sql`.
3. Bump `SCHEMA_VERSION` and add a history line in `apps/api/src/provisioning.ts`.
4. Apply to live restaurants: `cd apps/api && npx tsx scripts/apply-tenant-migration.ts ../../supabase/tenant-migrations/NNNN_description.sql`

## Checks before pushing

```bash
cd apps/api && npx tsc --noEmit -p .
cd apps/web && npx tsc --noEmit && npx next build
```

## Rules

- **Never read, print, copy or commit secrets.** `apps/api/.env` and `apps/web/.env.local` hold
  database service keys, OAuth secrets and email passwords — they stay on this computer and in
  Vercel's settings only. Only `NEXT_PUBLIC_*` values are public.
- Never expose the Supabase service-role key to the browser; never weaken RLS.
- Keep `package-lock.json` untracked.
- The AI Assistant's instructions and tools can be exported for AI Studio with
  `cd apps/api && npx tsx scripts/export-ai-studio.ts` (writes `docs/ai-studio/`).
