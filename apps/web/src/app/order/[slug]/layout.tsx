import type { Metadata } from 'next';
import { buildOrderMetadata } from '@/lib/portalMetadata';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return buildOrderMetadata(slug);
}

export default function OrderLayout({ children }: { children: React.ReactNode }) {
  return children;
}
