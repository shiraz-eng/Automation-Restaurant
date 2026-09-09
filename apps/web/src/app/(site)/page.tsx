import Link from 'next/link';
import { PricingCards } from '@/components/PricingCards';
import { FaqAccordion } from '@/components/FaqAccordion';

const SERVICES = [
  ['🧾', 'POS & Order Management', 'Fast order entry, holds, splits, receipts.'],
  ['👨‍🍳', 'Kitchen Display System', 'Real-time ticket queue with a prep workflow.'],
  ['📱', 'QR Table Ordering', 'Guests scan, order and pay — no app, no login.'],
  ['🪑', 'Tables & Floor', 'Live floor plan, sessions, transfers, merges.'],
  ['📅', 'Reservations', 'Calendar, waitlist, check-in, table assignment.'],
  ['📦', 'Inventory', 'Recipe-based deduction and an append-only ledger.'],
  ['🧮', 'Recipe & Food Costing', 'Know your margin on every dish.'],
  ['🚚', 'Supplier Management', 'Suppliers, purchase orders, stock transfers.'],
  ['🧑‍💼', 'Staff & Shifts', 'Roles, permissions, scheduling, attendance.'],
  ['💚', 'Customer CRM & Loyalty', 'Profiles, points, rewards, feedback.'],
  ['🏷️', 'Promotions', 'Discounts, combos, happy-hour, coupons.'],
  ['🛵', 'Delivery Management', 'Assign, dispatch, track to the door.'],
  ['💳', 'Payments', 'Cash, card and mobile, reconciled to the ledger.'],
  ['📊', 'Analytics & Reports', 'Sales, labour, food cost, exportable.'],
  ['🏢', 'Multi-Branch', 'Compare and manage every location centrally.'],
  ['🎨', 'Branding & Theme', 'Your colours across every screen.'],
];

const FEATURES = [
  ['One connected platform', 'Orders, kitchen, inventory, staff and payments share one source of truth — no exports between tools.'],
  ['Real-time everywhere', 'A placed order reaches the kitchen, cashier, waiter and manager instantly. Status changes propagate with no refresh.'],
  ['Secure multi-tenant', 'Every restaurant is isolated at the database level with Supabase Row Level Security — not just hidden menus.'],
  ['Role-specific portals', 'Kitchen, cashier, waiter and back-office each get their own interface built for the job, not one dashboard for all.'],
];

const TESTIMONIALS = [
  ['We replaced four apps with one. The kitchen and the till finally agree.', 'Operations lead, casual-dining group'],
  ['QR ordering cut our order-taking time in half on a busy Friday.', 'Owner, neighbourhood bistro'],
  ['Rolling out a new branch used to take a week of setup. Now it is a signup.', 'Franchise manager'],
];

const FAQS = [
  { q: 'What is Automation Restaurant?', a: 'An all-in-one restaurant management platform — orders, POS, kitchen, tables, inventory, staff, customers, payments and reporting in one connected system.' },
  { q: 'How do I get started?', a: 'Choose a plan, create your account, complete secure payment, and your restaurant workspace is provisioned automatically. Your portal link is emailed to you.' },
  { q: 'What happens immediately after I subscribe?', a: 'Once payment is verified, your subscription activates and your workspace is prepared. A secure Open Restaurant Portal link is sent to your checkout email.' },
  { q: 'Do I need technical knowledge or to install anything?', a: 'No. It is cloud-based and runs in a supported web browser. The interfaces are built for restaurant teams.' },
  { q: 'Is my payment secure?', a: 'Payments are processed by a secure third-party provider. Automation Restaurant does not store raw card details.' },
  { q: 'Can I upgrade my plan later?', a: 'Yes — upgrade as your restaurant grows and needs more capabilities. Feature access updates automatically with your subscription.' },
  { q: 'Can customers order through QR codes?', a: 'Yes. Guests scan a table QR code, browse the menu, order, track status, order more and leave feedback — no customer account required.' },
  { q: 'Will orders reach my kitchen in real time?', a: 'Yes. Orders flow between the customer, kitchen, cashier, waiter and management views in real time.' },
  { q: 'Can Automation Restaurant support multiple branches?', a: 'Yes, on eligible plans — manage multiple locations from one centralised platform.' },
  { q: 'What if I am not sure which plan to choose?', a: 'Start with the plan that matches your current needs, or contact our team before subscribing.' },
];

export default function Landing() {
  return (
    <>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pt-20 pb-16 text-center">
        <p className="text-primary text-xs font-bold uppercase tracking-widest mb-4">
          Restaurant Automation Platform
        </p>
        <h1 className="text-4xl md:text-6xl font-black leading-[1.05] max-w-3xl mx-auto">
          Run Your Restaurant Smarter. Automate Everything.
        </h1>
        <p className="text-muted mt-5 max-w-2xl mx-auto">
          A complete restaurant management platform for orders, kitchen operations, tables,
          staff, inventory, payments, customers, and analytics — all in one place.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/get-started"
            className="rounded-lg bg-primary text-primary-fg font-bold px-6 py-3"
          >
            Get Started
          </Link>
          <Link
            href="#services"
            className="rounded-lg border border-border font-semibold px-6 py-3"
          >
            Explore Services
          </Link>
        </div>
        <p className="text-muted text-[11px] mt-5">
          Secure checkout · Cloud-based · Fast onboarding · Real-time operations
        </p>
      </section>

      {/* Platform overview */}
      <section id="platform" className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16 grid gap-6 md:grid-cols-2">
          {FEATURES.map(([title, body]) => (
            <div key={title} className="rounded-xl border border-border p-6">
              <h3 className="font-bold">{title}</h3>
              <p className="text-muted text-sm mt-1.5">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Services */}
      <section id="services" className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="text-2xl md:text-3xl font-black text-center">Everything your restaurant runs on</h2>
        <p className="text-muted text-center mt-2">Modules included by plan — grow into them as you need.</p>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICES.map(([icon, name, desc]) => (
            <div key={name} className="rounded-xl border border-border bg-surface p-4">
              <div className="text-2xl">{icon}</div>
              <div className="font-semibold text-sm mt-2">{name}</div>
              <div className="text-muted text-xs mt-1">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="text-2xl md:text-3xl font-black text-center">Transparent, feature-gated pricing</h2>
          <p className="text-muted text-center mt-2 mb-10">Pick a plan; your workspace provisions automatically.</p>
          <PricingCards />
        </div>
      </section>

      {/* Testimonials */}
      <section className="mx-auto max-w-6xl px-5 py-20 grid gap-5 md:grid-cols-3">
        {TESTIMONIALS.map(([quote, who]) => (
          <figure key={who} className="rounded-xl border border-border bg-surface p-6">
            <blockquote className="text-sm">“{quote}”</blockquote>
            <figcaption className="text-muted text-xs mt-3">— {who}</figcaption>
          </figure>
        ))}
      </section>

      {/* FAQ */}
      <section id="faq" className="border-t border-border bg-surface">
        <div className="mx-auto max-w-3xl px-5 py-20">
          <h2 className="text-2xl md:text-3xl font-black text-center">
            Questions? We&apos;ve Got You Covered.
          </h2>
          <p className="text-muted text-center mt-2 mb-8">
            Everything you need to know before bringing Automation Restaurant to your business.
          </p>
          <FaqAccordion items={FAQS} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="mx-auto max-w-6xl px-5 py-20 text-center">
        <h2 className="text-2xl md:text-4xl font-black">Ready to Take Control of Your Restaurant?</h2>
        <p className="text-muted mt-3 max-w-xl mx-auto">
          Replace disconnected tools and manual processes with one modern restaurant management
          platform.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link href="/get-started" className="rounded-lg bg-primary text-primary-fg font-bold px-6 py-3">
            Get Started Now
          </Link>
          <Link href="/pricing" className="rounded-lg border border-border font-semibold px-6 py-3">
            View Pricing
          </Link>
        </div>
      </section>
    </>
  );
}
