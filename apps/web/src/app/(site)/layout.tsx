import Link from 'next/link';

const NAV = [
  ['#platform', 'Platform'],
  ['#services', 'Services'],
  ['/pricing', 'Pricing'],
  ['#faq', 'FAQ'],
];

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-main text-body">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto max-w-6xl px-5 h-16 flex items-center justify-between">
          <Link href="/" className="font-black text-lg">
            Automation<span className="text-primary">.</span>
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-sm text-muted">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-body">
                {label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2.5">
            <Link href="/login" className="text-sm font-semibold text-muted hover:text-body">
              Sign in
            </Link>
            <Link
              href="/get-started"
              className="rounded-lg bg-primary text-primary-fg text-sm font-semibold px-4 py-2"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div>
            <div className="font-black text-lg mb-2">
              Automation<span className="text-primary">.</span>
            </div>
            <p className="text-muted text-xs max-w-[220px]">
              A complete digital operating system for modern restaurants.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={[
              ['/#platform', 'Platform'],
              ['/#services', 'Features'],
              ['/#services', 'Services'],
              ['/pricing', 'Pricing'],
              ['/#faq', 'FAQ'],
            ]}
          />
          <FooterCol
            title="Company"
            links={[
              ['/contact', 'Contact'],
              ['/contact', 'Support'],
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
        <div className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
            <span>© 2026 Automation Restaurant. All rights reserved.</span>
            <Link href="/get-started" className="font-semibold text-primary">
              Ready to automate your restaurant? Get Started →
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="font-semibold mb-3">{title}</div>
      <ul className="space-y-2 text-muted text-xs">
        {links.map(([href, label], i) => (
          <li key={i}>
            <Link href={href} className="hover:text-body">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
