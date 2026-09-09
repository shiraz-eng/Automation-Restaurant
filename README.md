# Automation Restaurant — multi-portal HMS

A multi-tenant restaurant Hospitality Management System. Each restaurant runs on
its **own dedicated Supabase project**, provisioned automatically on signup.
Staff sign into **role-specific portals** (Kitchen, Cashier, Waiter, …) — not one
dashboard with hidden menus. Guests order from a table URL with no login and
watch their order status live.

## Layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Plan tiers + feature entitlements (used by API + web). |
| `apps/api` | Express: Stripe webhook + `signup`, per-restaurant **project provisioning** (Supabase Management API), staff invite, public storefront endpoints. |
| `apps/web` | Next.js App Router: the platform admin, every restaurant portal, the guest ordering flow. |
| `supabase/control-plane/*.sql` | The **registry** — runs once on the central project. |
| `supabase/tenant-template/schema.sql` | The schema applied to **every** new restaurant project. |

## Architecture

```
                       Control-plane Supabase project
                       (tenants, tenant_projects, subscriptions, registry)
                                  │
          signup ──> apps/api ──> Management API: create project ──> apply tenant schema
                                  │
   restaurant A project     restaurant B project     restaurant C project …
   (its own menu, orders,   (own auth users,         (fully isolated —
    inventory, staff auth)   own data)                 the project boundary is the wall)
```

The web app resolves `/r/<slug>/…` to that restaurant's project via the public
`tenant_directory` view, then talks to the project directly (RLS-scoped by the
staff member's JWT role). `/admin/…` talks to the control plane (super-admin only).

## Portals

| Portal | Route | For |
| --- | --- | --- |
| Platform admin | `/admin` | HMS owner — all restaurants, suspend/reactivate, provisioning status |
| Management | `/r/<slug>` | owner / manager — dashboard, orders, menu, inventory, reservations, staff, theme |
| Kitchen | `/r/<slug>/kitchen` | chef — New / Preparing / Ready ticket board |
| Cashier | `/r/<slug>/register` | cashier — open bills, cash/card/mobile, change calc, take payment |
| Waiter / Host | `/r/<slug>/floor` | waiter / host — orders by table, running total, mark served |
| Accountant | `/r/<slug>/finance` | accountant — revenue (today/7d/30d), payment split, tax |
| HR | `/r/<slug>/team` | hr — staff roster + invite |
| Delivery | `/r/<slug>/deliveries` | delivery — delivery-channel orders, pickup → delivered |
| Guest ordering | `/order/<slug>?table=…` | customer — no login; menu → cart → **live order tracking** → feedback |

Login at `/r/<slug>/login` routes each role to its own portal (`roleHome`), and
every portal layout re-checks the role server-side — a waiter can't reach the
owner dashboard by typing the URL.

## Real-time

Supabase Realtime is enabled on `orders` / `order_lines` in every tenant project.
A guest's tracking page subscribes to their order and updates with no refresh as
the kitchen advances it; the cashier / waiter / delivery boards react live too.

## Running it

```bash
npm run setup
# apps/api/.env  — control-plane SUPABASE_URL + SERVICE_ROLE_KEY,
#                  SUPABASE_ACCESS_TOKEN + SUPABASE_ORG_ID (Management API),
#                  STRIPE_* (only for the billing path)
# apps/web/.env.local — NEXT_PUBLIC_CONTROL_PLANE_URL + _ANON_KEY, NEXT_PUBLIC_API_URL

# control plane (run once, in the SQL editor or via psql):
#   supabase/control-plane/0001_control_plane.sql
#   supabase/control-plane/0002_super_admin.sql

npm run build && node apps/api/dist/server.js      # API :4000
npm run dev:web                                    # web :3005
```

Provision a restaurant without Stripe:
```bash
node apps/api/scripts/provision-test.cjs "Bistro Nine" owner@bistronine.test
```

## Not built

Table sessions (multi-order/table entity), QR-code generation, menu
images/modifiers, manager live-activity feed, shifts/attendance/payroll,
suppliers/purchase-orders, promotions, audit log. Provisioning is fire-and-forget
(needs a durable queue for production); tenant service keys are stored plaintext
in the registry (move to Vault/KMS).
