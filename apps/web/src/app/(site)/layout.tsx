import Link from 'next/link';
import { Fraunces, Manrope } from 'next/font/google';
import { ChefHat } from 'lucide-react';
import { MobileMenu } from './MobileMenu';
import { GuideAiWidget } from '@/components/GuideAiWidget';

// Scoped to the marketing site only (via the font-variable classes below) —
// the RMS portal keeps its own current typography untouched. Fraunces (a
// characterful serif) carries headlines for the premium/editorial feel;
// Manrope stays the clean body/UI face.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-display', display: 'swap', weight: ['500', '600', '700'] });
const manrope = Manrope({ subsets: ['latin'], variable: '--font-body', display: 'swap' });

const NAV: [string, string][] = [
  ['/#platform', 'Platform'],
  ['/#connected', 'Solutions'],
  ['/#ai', 'AI'],
  ['/pricing', 'Pricing'],
  ['/#faq', 'Resources'],
];

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${fraunces.variable} ${manrope.variable} font-body min-h-screen flex flex-col bg-main text-body`}>
      <header className="sticky top-0 z-40 bg-ink/90 backdrop-blur-md text-ink-fg relative">
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-gold/40 to-transparent" />
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-display font-semibold text-lg tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gold text-ink">
              <ChefHat size={17} strokeWidth={2.4} />
            </span>
            Automation<span className="text-gold">.</span>
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-[13.5px] font-medium text-ink-muted">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-ink-fg transition-colors">
                {label}
              </Link>
            ))}
          </nav>
          <div className="hidden md:flex items-center gap-2.5">
            <Link href="/login" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink-fg transition-colors px-2">
              Sign in
            </Link>
            <Link
              href="/get-started"
              className="rounded-lg bg-black border border-white/15 text-white text-[13.5px] font-bold px-4 py-2 transition-all hover:-translate-y-px hover:border-gold/50"
            >
              Get Started
            </Link>
          </div>
          <MobileMenu items={NAV} />
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <SiteFooter />
      <GuideAiWidget mode="public" />
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="bg-ink text-ink-fg">
      <div className="mx-auto max-w-6xl px-5 py-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-6 text-sm">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2 font-display font-semibold text-lg">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gold text-ink">
              <ChefHat size={15} strokeWidth={2.4} />
            </span>
            Automation<span className="text-gold">.</span>
          </div>
          <p className="text-ink-muted text-xs max-w-[240px] mt-3 leading-relaxed">
            One connected operating system for running a restaurant — orders, kitchen, inventory,
            suppliers, finance, staff, marketing, analytics and AI, in one place.
          </p>
        </div>
        <FooterCol
          title="Product"
          links={[
            ['/#platform', 'Platform'],
            ['/#platform', 'Features'],
            ['/#ai', 'AI'],
            ['/pricing', 'Pricing'],
            ['/guide', 'AI Guide'],
          ]}
        />
        <FooterCol
          title="Solutions"
          links={[
            ['/#operations', 'Operations'],
            ['/#inventory', 'Inventory'],
            ['/#finance', 'Finance'],
            ['/#marketing', 'Marketing'],
            ['/#customer', 'Customer Experience'],
          ]}
        />
        <FooterCol
          title="Resources"
          links={[
            ['/#faq', 'FAQ'],
            ['/contact', 'Contact'],
          ]}
        />
        <FooterCol
          title="Legal"
          links={[
            ['/privacy-policy', 'Privacy Policy'],
            ['/terms-and-conditions', 'Terms & Conditions'],
          ]}
        />
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto max-w-6xl px-5 py-5 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-muted">
          <span>© {new Date().getFullYear()} Automation Restaurant. All rights reserved.</span>
          <Link href="/get-started" className="font-semibold text-gold hover:underline">
            Ready to run your restaurant on one system? Get Started →
          </Link>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="font-semibold mb-3 text-ink-fg">{title}</div>
      <ul className="space-y-2 text-ink-muted text-xs">
        {links.map(([href, label], i) => (
          <li key={i}>
            <Link href={href} className="hover:text-ink-fg transition-colors">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
