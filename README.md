# Automation Restaurant

**One connected operating system for a restaurant** — customer ordering, kitchen
tickets, recipes, inventory, suppliers, finance, staff and AI, all on the same
live data.

- Website: https://web-rho-rosy-56.vercel.app
- Each restaurant runs on **its own Supabase project**, created automatically at
  sign-up. One restaurant's data never shares a database with another's.

---

## What it does

| Area | Features |
| --- | --- |
| **Guests** | Table QR codes, no-login ordering (`/order/<slug>?table=…`), search and categories, deals with the saving shown, special instructions, promo codes, tax shown before checkout, live order tracking (placed → in the kitchen → ready → served), order more from the same table, five-part ratings, "Ask about the menu" AI |
| **Kitchen** | Kitchen Display (KOT queue → preparing → ready), the ingredients each ticket consumes, portions left per dish, KOT history |
| **Menu & recipes** | Categories, variants, modifiers, deals, promotions; recipes in base units (g / ml / piece) linked to dishes; per-dish food cost and margin; availability calculated from stock |
| **Inventory** | Stock on hand, low-stock thresholds and email alerts, automatic deduction by recipe on every order, shared-ingredient impact across dishes |
| **Purchasing** | Supplier directory with payment terms, purchase requests → purchase orders → goods received → stock update → supplier bills |
| **Finance** | Live performance panel (any period, restaurant time zone), net sales, tax collected, gross and net profit, expenses, day close, branded PDF and Excel P&L exports |
| **Staff & access** | Staff without logins (name, job, shift), custom portals built from individual permissions with a live preview, approvals, audit log, attendance and scheduling |
| **AI** | Owner assistant (live answers from restaurant data, reads and creates PDFs, every chat saved), Smart Import (upload a menu, recipe, inventory, supplier, table, staff or PO document → reviewable draft → approve), customer menu assistant, website AI Guide |
| **Brand** | Brand Kit (logo, colours, receipt style) applied to the menu, receipts, invoices and reports |
| **Platform** | Marketing site, self-service sign-up and payment, automatic provisioning, plan tiers and upgrades, super-admin console |

## How a restaurant goes live

| Step | What happens |
| --- | --- |
| 1. Sign up | Pick a plan on the website, fill in one form, pay. The owner connects a free Supabase account and a dedicated database is provisioned automatically, then a set-password email is sent. |
| 2. AI import | Upload existing menu, recipe, inventory and supplier files; review the draft (new / changed / missing prices); approve. |
| 3–6. Check the data | Suppliers, inventory (costs and alert levels), recipes (food cost per dish), menu (each dish linked to its recipe). |
| 7. Portals | Give each job its own portal from individual permissions. |
| 8. Order | Guests scan the table QR code, or the cashier rings the order up. |
| 9. Kitchen | The KOT appears on the Kitchen Display; the guest's tracking page follows it. |
| 10. Stock | Every ingredient in the order's recipes is deducted; availability updates. |
| 11. Purchasing | Low stock alerts the owner and drafts a purchase order to the supplier. |
| 12. Results | Dashboard, reports and the AI assistant all read the same numbers. |

## Architecture

```
                 Control-plane Supabase project
                 (tenants, plans, subscriptions, provisioning, registry)
                               │
  website sign-up ──> apps/api ──> Supabase OAuth / Management API
                               │      create project → apply tenant schema → seed roles + settings
                               │
   restaurant A project    restaurant B project    restaurant C project …
   (own auth users, menu,  (fully isolated —       (RLS on every table,
    orders, stock, chats)   own database)           permission-checked RPCs)
```

- **`apps/web`** resolves `/r/<slug>/…` to that restaurant's project and talks to
  it with the signed-in user's JWT, so Row Level Security applies to every read.
- **`apps/api`** handles anything that needs a secret: provisioning, billing,
  e-mail, AI calls, imports and cron jobs. It resolves the tenant and the user's
  permissions from the JWT on the server and never trusts IDs, roles or
  permissions sent by the browser.
- Service-role keys stay on the server and are never sent to the browser.

## Repository layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js 15 (App Router): marketing site, sign-up and onboarding, restaurant portal, custom portals, guest ordering, super-admin |
| `apps/api` | Express API (deployed to Vercel as a serverless function): provisioning, billing, staff, AI assistant and imports, customer AI, AI Guide, cron |
| `packages/shared` | Plan tiers and feature entitlements shared by API and web |
| `supabase/control-plane` | Migrations for the central registry project |
| `supabase/tenant-template/schema.sql` | Full schema applied to every new restaurant |
| `supabase/tenant-migrations` | Numbered migrations rolled out to existing restaurants |
| `docs/ai-studio` | System prompt and function declarations exported for Google AI Studio |

## Main routes

| Route | For |
| --- | --- |
| `/`, `/pricing`, `/guide`, `/get-started` | Public website, plans, setup guide, sign-up |
| `/onboarding/…` | Payment confirmation, database connection, provisioning status, set password |
| `/r/<slug>/login` | Staff sign-in for one restaurant |
| `/r/<slug>` | Owner dashboard and every portal page (orders, KDS, menu, recipes, inventory, purchasing, suppliers, finance, staff, AI, settings …) |
| `/r/<slug>/portal/<portalKey>` | A custom portal, composed from its permissions |
| `/order/<slug>?table=…` | Guest ordering, tracking and feedback |
| `/admin` | Platform super-admin |

## Plans

| Plan | Monthly | Annual (per month) |
| --- | --- | --- |
| Starter | $49 | $39 |
| Professional | $129 | $103 |
| Enterprise | $299 | $239 |

Features are enforced per plan in both the API and the portal (`packages/shared`).

## Local development

Requires Node.js 20+.

```bash
npm run setup      # install + build packages/shared
npm run dev:api    # API on http://localhost:4000
npm run dev:web    # web on http://localhost:3000
npm run typecheck  # shared + api + web
```

Environment variables (names only — never commit values):

- **`apps/api/.env`** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (control plane),
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID`, `SUPABASE_OAUTH_CLIENT_ID`,
  `SUPABASE_OAUTH_CLIENT_SECRET`, `SUPABASE_OAUTH_REDIRECT_URI`, `APP_URL`,
  `ALLOWED_ORIGINS`, `GEMINI_API_KEY`, `RESEND_API_KEY` or `SMTP_*`, `EMAIL_FROM`,
  `CRON_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MAP`,
  `PAYMENTS_MODE`. See `apps/api/src/env.ts` for the full list and defaults.
- **`apps/web/.env.local`** — `NEXT_PUBLIC_CONTROL_PLANE_URL`,
  `NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`.

## Database changes

Every tenant schema change is done three ways so new and existing restaurants match:

1. Add `supabase/tenant-migrations/NNNN_name.sql`.
2. Mirror it into `supabase/tenant-template/schema.sql`.
3. Bump `SCHEMA_VERSION` in `apps/api/src/provisioning.ts` (currently **82**).

Roll it out to every live restaurant:

```bash
cd apps/api
npx tsx scripts/apply-tenant-migration.ts ../../supabase/tenant-migrations/NNNN_name.sql
```

Never weaken RLS; new tables get policies in the same migration.

## Deployment

Both apps deploy to Vercel from `main`:

- **web** — root `apps/web`, framework Next.js.
- **automation-restaurant-api** — root `apps/api`, served through `api/index.ts`.

Scheduled jobs (low-stock alerts and similar) call the API's cron routes with
`CRON_SECRET`. See `VERCEL_DEPLOY.md` for the web environment variables.

## Test scripts

`apps/api/scripts/` holds end-to-end checks against real tenant projects, for
example `rbac-test.cjs`, `portals-test.cjs`, `realtime-test.cjs`,
`test-recipe-linking.ts`, `test-availability-engine.ts` and
`test-performance-access.ts`.

## Known limitations

- AI features use Google Gemini; the free quota can run out (HTTP 429/503). Use a paid key for production.
- Stripe price IDs must be set in `STRIPE_PRICE_MAP` before live card payments work.
