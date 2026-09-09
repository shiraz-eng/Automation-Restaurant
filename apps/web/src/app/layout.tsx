import type { Metadata } from 'next';
import { ThemeProvider } from '@/components/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Automation Restaurant',
  description: 'Multi-tenant restaurant management.',
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
