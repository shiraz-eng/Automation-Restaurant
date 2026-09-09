import { LegalDoc, Fill, type LegalSection } from '@/components/LegalDoc';

export const metadata = { title: 'Terms & Conditions — Automation Restaurant' };

const P = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;

const sections: LegalSection[] = [
  { heading: 'Acceptance of Terms', body: <P>By creating an account or using the service you agree to these Terms.</P> },
  { heading: 'Description of the Service', body: <P>Automation Restaurant is a cloud restaurant management platform including POS, kitchen, tables, inventory, staff, payments, reporting and guest QR ordering.</P> },
  { heading: 'Eligibility', body: <P>You must be able to form a binding contract and use the service for a lawful business purpose.</P> },
  { heading: 'Account Registration', body: <P>You are responsible for the accuracy of registration information and for safeguarding account credentials.</P> },
  { heading: 'Restaurant Account Responsibilities', body: <P>The restaurant account owner is responsible for its users, roles, permissions and the data entered into the workspace.</P> },
  { heading: 'Subscription Plans', body: <P>Features and limits are determined by the selected plan. Plans and inclusions may change with notice.</P> },
  { heading: 'Pricing and Billing', body: <P>Fees are charged in advance for the selected billing cycle. <Fill label="Taxes and currency terms" /></P> },
  { heading: 'Payment Processing', body: <P>Payments are handled by a third-party provider. We verify payment server-side before activating a subscription. We do not store raw card data.</P> },
  { heading: 'Subscription Renewal', body: <P>Subscriptions renew automatically at the end of each billing cycle unless cancelled beforehand.</P> },
  { heading: 'Upgrades and Downgrades', body: <P>You may change plans; feature access updates automatically. <Fill label="Proration terms" /></P> },
  { heading: 'Cancellation', body: <P>You may cancel from the billing section. Access continues until the end of the paid period.</P> },
  { heading: 'Refunds', body: <P><Fill label="Refund policy" /></P> },
  { heading: 'Acceptable Use', body: <P>Do not misuse the service, attempt to breach security or isolation, or use it unlawfully.</P> },
  { heading: 'Customer and Restaurant Data', body: <P>You retain rights to your data. We process it to provide the service and delete or return it per the Privacy Policy on termination.</P> },
  { heading: 'Intellectual Property', body: <P>The platform, software and branding are owned by Automation Restaurant. You receive a limited right to use the service during your subscription.</P> },
  { heading: 'Third-Party Services', body: <P>The service integrates payment, hosting and email providers subject to their own terms.</P> },
  { heading: 'Service Availability', body: <P>We aim for high availability but do not guarantee uninterrupted service. <Fill label="SLA, if offered" /></P> },
  { heading: 'Support', body: <P>Support is provided according to your plan&apos;s support level.</P> },
  { heading: 'Security', body: <P>We implement row-level isolation, role-based access, server-side authorization, webhook verification and audit logging.</P> },
  { heading: 'Limitation of Liability', body: <P><Fill label="Liability limitation" /></P> },
  { heading: 'Indemnification', body: <P><Fill label="Indemnification terms" /></P> },
  { heading: 'Suspension or Termination', body: <P>We may suspend or terminate accounts for non-payment, abuse, or legal reasons.</P> },
  { heading: 'Changes to the Service', body: <P>We may modify or discontinue features with reasonable notice.</P> },
  { heading: 'Changes to These Terms', body: <P>We may update these Terms and will post the revised version with a new effective date.</P> },
  { heading: 'Governing Law and Jurisdiction', body: <P><Fill label="Governing law and jurisdiction" /></P> },
  { heading: 'Contact Information', body: <P><Fill label="Contact email" /> · <Fill label="Business address" /></P> },
];

export default function TermsPage() {
  return <LegalDoc title="Terms & Conditions" sections={sections} />;
}
