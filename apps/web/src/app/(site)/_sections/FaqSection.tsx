import { Section } from '@/components/marketing/Section';
import { FaqAccordion, type Faq } from '@/components/FaqAccordion';
import { getSectionContent } from '@/lib/cms/content';
import type { FaqContent } from '@/lib/cms/schemas';

const DEFAULT_FAQS: Faq[] = [
  {
    q: 'What is Automation Restaurant?',
    a: 'An all-in-one restaurant operating system — orders, kitchen, inventory, recipes, suppliers, finance, staff, marketing, analytics, a customer experience and AI, all connected to the same restaurant data.',
  },
  {
    q: 'Is Automation Restaurant only a POS?',
    a: 'No. POS/order-taking is one part of it. Inventory, recipes and food cost, suppliers and purchasing, finance, staff and custom portals, marketing, analytics and AI are all built into the same platform.',
  },
  {
    q: 'Can I create custom portals for my staff?',
    a: 'Yes. There are no fixed "Kitchen Portal" or "Finance Portal" bundles — you build a portal from individual permissions and assign it to whoever needs it, so each person’s workspace matches exactly what they’re supposed to access.',
  },
  {
    q: 'Can I control exactly what each employee can access?',
    a: 'Yes. Access is permission-based, not role-based guesswork — you choose the exact permissions a portal grants, down to individual modules and actions.',
  },
  {
    q: 'Can different restaurants have different branding?',
    a: 'Yes. Each restaurant configures its own Brand Kit — logo, colors and portal identity — which is isolated per restaurant and never shared or shown to another.',
  },
  {
    q: 'Can my invoices and receipts use my restaurant branding?',
    a: 'Yes. Receipts and PDF reports are built from a configurable template that pulls your restaurant’s logo, colors and business details from the same Brand Kit.',
  },
  {
    q: 'Can my restaurant use its own email identity?',
    a: 'Operational emails (like low-stock supplier alerts) are sent with your restaurant’s name and reply-to address, so replies reach your restaurant rather than the platform.',
  },
  {
    q: 'Does inventory connect with recipes and purchasing?',
    a: 'Yes. Recipes define what a sale consumes, sales deduct real stock automatically, and low stock can flow straight into a purchase request with your preferred supplier.',
  },
  {
    q: 'Does Finance connect with sales and purchasing?',
    a: 'Yes. Revenue reconciles against real orders, cost of goods reconciles against recipes and inventory movement, and supplier payments track against purchase orders — not separate, manually re-entered figures.',
  },
  {
    q: 'What does the AI assistant do?',
    a: 'It answers questions about your restaurant’s live data — sales, inventory, finance, operations — and surfaces insight across the platform. Sensitive actions still go through the platform’s own permissions and approval workflows, not the AI acting on its own.',
  },
  {
    q: 'Can I use the platform for multiple restaurant locations?',
    a: 'Yes, on eligible plans — multi-branch management lets you run and compare several locations from one account.',
  },
  {
    q: 'How do I get started, and what happens after I subscribe?',
    a: 'Choose a plan, create your account and complete secure checkout. Once payment is verified, your restaurant workspace is provisioned automatically and a secure portal link is emailed to you.',
  },
  {
    q: 'Can I change plans later, and is billing monthly or annual?',
    a: 'Both monthly and annual billing are available (annual at a discount), and you can move to a plan that fits as your restaurant grows — feature access updates with your subscription.',
  },
];

const DEFAULT: FaqContent = { eyebrow: 'FAQ', title: 'Questions? We’ve got you covered.', items: DEFAULT_FAQS };

export async function FaqSection() {
  const result = await getSectionContent('faq', 'faq');
  if (result.state === 'hidden') return null;
  const content = result.state === 'active' ? result.content : DEFAULT;
  return (
    <Section id="faq" width="narrow" eyebrow={content.eyebrow} title={content.title}>
      <FaqAccordion items={content.items} />
    </Section>
  );
}
