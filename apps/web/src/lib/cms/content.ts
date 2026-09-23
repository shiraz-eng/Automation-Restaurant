import { parseSectionContent, type SectionType } from './schemas';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const CP_URL =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ckxxpyzxsbhhynlboyid.supabase.co';
const CP_ANON =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNreHhweXp4c2JoaHlubGJveWlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg5NTU0MzQsImV4cCI6MjEwNDUzMTQzNH0.aqDrwPKSEyZxeDrRLCncvbinLik2IWsZmUlz3RoIjnM';

type SiteSectionRow = {
  slug: string;
  section_type: string;
  content: unknown;
  is_active: boolean;
  sort_order: number;
};

export type FaqItem = { id: string; category: string; question: string; answer: string };

const DEFAULT_FAQ_ITEMS: FaqItem[] = [
  {
    id: 'f1',
    category: 'General',
    question: 'How do I get started, and what happens after I subscribe?',
    answer:
      'Choose a plan, create your account, and complete secure checkout. Once payment is verified, your restaurant workspace provisions automatically and your secure portal credentials are ready immediately.',
  },
  {
    id: 'f2',
    category: 'General',
    question: 'Can I control exactly what each employee can access?',
    answer:
      'Yes. Access is permission-based and role-scoped: kitchen staff only see order tickets, cashiers see checkout, and owners have complete administrative oversight.',
  },
  {
    id: 'f3',
    category: 'General',
    question: 'Does inventory connect with recipes and purchasing?',
    answer:
      'Yes. Recipes define ingredients consumed per dish, sales deduct raw stock automatically in real time, and low stock warnings alert managers before ingredients run out.',
  },
  {
    id: 'f4',
    category: 'General',
    question: 'What does the AI assistant do?',
    answer:
      'The AI Guide explains features, diagnoses account setup, compares plans, and assists onboarding. The Operations AI inside your portal helps with menu creation, ticket analysis, and inventory insights.',
  },
  {
    id: 'f5',
    category: 'General',
    question: 'Can I switch plans or billing cycles later?',
    answer:
      'Yes. You can switch between monthly and annual billing, or upgrade from Starter to Professional at any time through the Billing portal.',
  },
];

async function fetchAllSections(): Promise<SiteSectionRow[]> {
  if (API && !API.includes('localhost:4000')) {
    try {
      const res = await fetch(`${API}/api/public/site-content`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { sections: SiteSectionRow[] };
        if (body.sections?.length) return body.sections;
      }
    } catch {
      // Fall through
    }
  }

  // Direct Supabase query
  try {
    const res = await fetch(
      `${CP_URL}/rest/v1/site_sections?select=*&is_active=eq.true&order=sort_order`,
      {
        headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as SiteSectionRow[];
      if (Array.isArray(data) && data.length) return data;
    }
  } catch {
    // Fall through
  }

  return [];
}

export type SectionResult<T> =
  | { state: 'active'; content: T }
  | { state: 'hidden' }
  | { state: 'missing' };

export async function getFaqItems(): Promise<{ category: string; items: { q: string; a: string }[] }[]> {
  let items: FaqItem[] = [];

  if (API && !API.includes('localhost:4000')) {
    try {
      const res = await fetch(`${API}/api/public/faq-items`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { items: FaqItem[] };
        if (body.items?.length) items = body.items;
      }
    } catch {
      // Fall through
    }
  }

  if (!items.length) {
    // Direct Supabase query
    try {
      const res = await fetch(
        `${CP_URL}/rest/v1/faq_items?select=*&is_published=eq.true&order=sort_order`,
        {
          headers: { apikey: CP_ANON, Authorization: `Bearer ${CP_ANON}` },
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as FaqItem[];
        if (Array.isArray(data) && data.length) items = data;
      }
    } catch {
      // Fall through
    }
  }

  if (!items.length) {
    items = DEFAULT_FAQ_ITEMS;
  }

  const byCategory = new Map<string, { q: string; a: string }[]>();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push({ q: item.question, a: item.answer });
    byCategory.set(item.category, list);
  }
  return [...byCategory.entries()].map(([category, items]) => ({ category, items }));
}

export async function getSectionContent<T extends SectionType>(
  slug: string,
  type: T,
): Promise<SectionResult<Exclude<ReturnType<typeof parseSectionContent<T>>, null>>> {
  const rows = await fetchAllSections();
  const row = rows.find((r) => r.slug === slug && r.section_type === type);
  if (!row) return { state: 'missing' };
  if (!row.is_active) return { state: 'hidden' };
  const parsed = parseSectionContent(type, row.content);
  if (!parsed) return { state: 'missing' };
  return { state: 'active', content: parsed as Exclude<ReturnType<typeof parseSectionContent<T>>, null> };
}
