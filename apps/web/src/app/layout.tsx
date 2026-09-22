import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

const SITE_URL = 'https://automationrestaurant.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
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
    if (t.tokens.primary) r.style.setProperty('--primary', t.tokens.primary);
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
      </head>
      <body className="min-h-screen antialiased text-[14px]">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
