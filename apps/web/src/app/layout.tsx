import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/ThemeProvider';
import { A11Y_NO_FLASH } from '@/lib/a11yScript';
import './globals.css';

const SITE_URL = 'https://automationrestaurant.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // The Automation Restaurant robot — the website's own icon. Every restaurant's portal and
  // guest pages declare their own (lib/portalMetadata.ts), so this never shows inside one.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180' }],
  },
  title: {
    default: 'Automation Restaurant — The Operating System for Your Restaurant',
    template: '%s — Automation Restaurant',
  },
  description:
    'Automation Restaurant connects orders, kitchen, inventory, recipes, suppliers, finance, staff, marketing, analytics and AI into one restaurant operating system — not just a POS.',
  keywords: [
    'restaurant management software',
    'restaurant operating system',
    'POS system',
    'kitchen display system',
    'restaurant inventory management',
    'restaurant analytics',
  ],
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Automation Restaurant',
    title: 'Automation Restaurant — The Operating System for Your Restaurant',
    description:
      'One connected platform for orders, kitchen, inventory, suppliers, finance, staff, marketing, analytics and AI.',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'Automation Restaurant' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Automation Restaurant — The Operating System for Your Restaurant',
    description:
      'One connected platform for orders, kitchen, inventory, suppliers, finance, staff, marketing, analytics and AI.',
    images: ['/og-image.png'],
  },
};

// Applies the stored theme before first paint to avoid a flash of the default.
const noFlash = `
try {
  var t = JSON.parse(localStorage.getItem('ar-theme') || '{}');
  var r = document.documentElement;
  if (t.tokens) {
    if (t.tokens.primary) {
      r.style.setProperty('--primary', t.tokens.primary);
      // Readable brand text (lib/theme.ts readableTextChannels): mixed toward black/white to 4.5:1.
      var lum = function (c) { return c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0); };
      var con = function (a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      var mix = function (bgs, to) { var p = t.tokens.primary.trim().split(/\\s+/).map(Number); bgs = bgs.concat(bgs.map(function (bg) { return bg.map(function (c, i) { return c + (p[i] - c) * 0.12; }); })); for (var k = 0; k <= 20; k++) { var m = p.map(function (c, i) { return Math.round(c + (to[i] - c) * k / 20); }); if (bgs.every(function (bg) { return con(m, bg) >= 4.5; })) return m.join(' '); } return to.join(' '); };
      r.style.setProperty('--primary-text-light', mix([[255, 255, 255], [248, 250, 252]], [0, 0, 0]));
      r.style.setProperty('--primary-text-dark', mix([[9, 9, 14], [20, 20, 26]], [255, 255, 255]));
    }
    if (t.tokens['primary-fg']) r.style.setProperty('--primary-fg', t.tokens['primary-fg']);
    if (t.tokens.radius) r.style.setProperty('--radius', t.tokens.radius);
  }
  if (t.appearance === 'light' || t.appearance === 'dark') r.setAttribute('data-theme', t.appearance);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
        <script dangerouslySetInnerHTML={{ __html: A11Y_NO_FLASH }} />
      </head>
      <body className="min-h-screen antialiased text-[0.875rem]">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
