-- ============================================================================
-- Control-plane 0011 — marketing site CMS
--
-- One row per landing-page section instance. content's shape is validated
-- per section_type by apps/web/src/lib/cms/schemas.ts (Zod) on both the
-- admin save path and the render path — a malformed/missing row falls back
-- to the section's own bundled default rather than ever crashing the
-- homepage. Seeded here from each section's CURRENT hardcoded copy, so this
-- migration is a behavior-preserving cutover, same as the plans migration.
--
-- This pass seeds/converts 5 of the 20 section instances (one per distinct
-- content shape, proving the pattern end to end): hero, trust-strip, faq,
-- final-cta, pricing-teaser. The remaining 15 stay hardcoded until a
-- follow-up batch adds their rows and section_types.
-- ============================================================================

create table public.site_sections (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,
  section_type text not null,
  content      jsonb not null default '{}'::jsonb,
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger site_sections_set_updated_at
  before update on public.site_sections
  for each row execute function app.set_updated_at();

alter table public.site_sections enable row level security;

create policy anon_read_active on public.site_sections
  for select using (is_active);

create policy super_admin_all on public.site_sections
  for all using (app.is_super_admin()) with check (app.is_super_admin());

grant select on public.site_sections to anon, authenticated;

insert into public.site_sections (slug, section_type, sort_order, content) values
('hero', 'hero', 1, '{
  "badge": "The Restaurant Operating System",
  "headline": "The Operating System for Your Restaurant.",
  "subhead": "Connecting your entire operation: Orders → Operations → Kitchen → Inventory → Purchasing → Finance → Marketing → Analytics → Customers → AI.",
  "primaryCta": { "label": "Get Started", "href": "/get-started" },
  "secondaryCta": { "label": "Explore the Platform", "href": "/#platform" },
  "connects": ["Orders", "Operations", "Kitchen", "Inventory", "Purchasing", "Finance", "Marketing", "Analytics", "Customers", "AI"],
  "image": { "src": "/images/hero-dark-kitchen.jpg", "alt": "Chefs working the pass in a modern restaurant kitchen" },
  "kitchenTickets": [
    { "table": "Table 5", "status": "In Prep" },
    { "table": "Table 6", "status": "In Prep" },
    { "table": "Table 7", "status": "In Prep" },
    { "table": "Table 8", "status": "Ready" }
  ],
  "inventoryAlert": { "title": "Inventory alert", "text": "Low stock: 3 ingredients" },
  "aiRecommendation": { "title": "AI Recommendation", "text": "Ribeye is trending toward a stockout before Saturday service — reorder suggested.", "linkText": "Review inventory" }
}'::jsonb),

('trust-strip', 'flat_list', 3, '{
  "heading": "Built for restaurants that want one connected system",
  "items": ["Quick Service", "Fast Casual", "Full Service", "Cafés & Bakeries", "Fine Dining", "Food Trucks", "Restaurant Groups"]
}'::jsonb),

('pricing-teaser', 'copy_only', 18, '{
  "eyebrow": "Pricing",
  "title": "Transparent, feature-gated pricing",
  "subtitle": "Pick a plan — your restaurant workspace provisions automatically after checkout."
}'::jsonb),

('faq', 'faq', 19, '{
  "eyebrow": "FAQ",
  "title": "Questions? We’ve got you covered.",
  "items": [
    { "q": "What is Automation Restaurant?", "a": "An all-in-one restaurant operating system — orders, kitchen, inventory, recipes, suppliers, finance, staff, marketing, analytics, a customer experience and AI, all connected to the same restaurant data." },
    { "q": "Is Automation Restaurant only a POS?", "a": "No. POS/order-taking is one part of it. Inventory, recipes and food cost, suppliers and purchasing, finance, staff and custom portals, marketing, analytics and AI are all built into the same platform." },
    { "q": "Can I create custom portals for my staff?", "a": "Yes. There are no fixed “Kitchen Portal” or “Finance Portal” bundles — you build a portal from individual permissions and assign it to whoever needs it, so each person’s workspace matches exactly what they’re supposed to access." },
    { "q": "Can I control exactly what each employee can access?", "a": "Yes. Access is permission-based, not role-based guesswork — you choose the exact permissions a portal grants, down to individual modules and actions." },
    { "q": "Can different restaurants have different branding?", "a": "Yes. Each restaurant configures its own Brand Kit — logo, colors and portal identity — which is isolated per restaurant and never shared or shown to another." },
    { "q": "Can my invoices and receipts use my restaurant branding?", "a": "Yes. Receipts and PDF reports are built from a configurable template that pulls your restaurant’s logo, colors and business details from the same Brand Kit." },
    { "q": "Can my restaurant use its own email identity?", "a": "Operational emails (like low-stock supplier alerts) are sent with your restaurant’s name and reply-to address, so replies reach your restaurant rather than the platform." },
    { "q": "Does inventory connect with recipes and purchasing?", "a": "Yes. Recipes define what a sale consumes, sales deduct real stock automatically, and low stock can flow straight into a purchase request with your preferred supplier." },
    { "q": "Does Finance connect with sales and purchasing?", "a": "Yes. Revenue reconciles against real orders, cost of goods reconciles against recipes and inventory movement, and supplier payments track against purchase orders — not separate, manually re-entered figures." },
    { "q": "What does the AI assistant do?", "a": "It answers questions about your restaurant’s live data — sales, inventory, finance, operations — and surfaces insight across the platform. Sensitive actions still go through the platform’s own permissions and approval workflows, not the AI acting on its own." },
    { "q": "Can I use the platform for multiple restaurant locations?", "a": "Yes, on eligible plans — multi-branch management lets you run and compare several locations from one account." },
    { "q": "How do I get started, and what happens after I subscribe?", "a": "Choose a plan, create your account and complete secure checkout. Once payment is verified, your restaurant workspace is provisioned automatically and a secure portal link is emailed to you." },
    { "q": "Can I change plans later, and is billing monthly or annual?", "a": "Both monthly and annual billing are available (annual at a discount), and you can move to a plan that fits as your restaurant grows — feature access updates with your subscription." }
  ]
}'::jsonb),

('final-cta', 'cta', 20, '{
  "headline": "Run your restaurant from one connected system.",
  "subtext": "Bring operations, inventory, finance, staff, customers and intelligence into one place.",
  "primaryCta": { "label": "Get Started", "href": "/get-started" },
  "secondaryCta": { "label": "Book a Demo", "href": "/contact" }
}'::jsonb);
