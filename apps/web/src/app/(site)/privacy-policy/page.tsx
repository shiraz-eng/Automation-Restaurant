import { LegalDoc, Fill, type LegalSection } from '@/components/LegalDoc';

export const metadata = { title: 'Privacy Policy — Automation Restaurant' };

const P = ({ children }: { children: React.ReactNode }) => <p>{children}</p>;

const sections: LegalSection[] = [
  {
    heading: 'Introduction',
    body: (
      <P>
        This Privacy Policy explains how <Fill label="Legal business name" /> (&ldquo;Automation
        Restaurant&rdquo;, &ldquo;we&rdquo;) collects, uses and protects information when you use
        our restaurant management platform and public website.
      </P>
    ),
  },
  {
    heading: 'Information We Collect',
    body: (
      <ul className="list-disc pl-5 space-y-1">
        <li>Name and contact details (email, phone).</li>
        <li>Restaurant and business information provided at signup.</li>
        <li>Account credentials (passwords are stored only as salted hashes).</li>
        <li>Subscription and billing status.</li>
        <li>Payment transaction metadata from our payment provider (not raw card numbers).</li>
        <li>Technical and usage information such as device, browser and log data.</li>
      </ul>
    ),
  },
  {
    heading: 'How We Use Information',
    body: (
      <P>
        To provide and operate the service, provision restaurant workspaces, process
        subscriptions, provide support, secure the platform, and communicate service and
        account information.
      </P>
    ),
  },
  {
    heading: 'Account and Restaurant Data',
    body: (
      <P>
        Data entered into a restaurant workspace (menus, orders, staff, inventory, customer
        records) is controlled by that restaurant. We process it on their behalf to run the
        service and isolate each restaurant&apos;s data from others.
      </P>
    ),
  },
  {
    heading: 'Payment Information',
    body: (
      <P>
        Card details are collected and processed by our third-party payment provider through
        their secure checkout. Automation Restaurant does not intentionally store raw credit or
        debit card numbers.
      </P>
    ),
  },
  {
    heading: 'Cookies and Similar Technologies',
    body: <P>We use strictly necessary cookies for authentication and session handling. <Fill label="Analytics / cookie details" /></P>,
  },
  {
    heading: 'Service Providers and Third Parties',
    body: <P>We share information with infrastructure, payment and email providers strictly as needed to run the service. <Fill label="Named sub-processors" /></P>,
  },
  { heading: 'Data Security', body: <P>We use access controls, encryption in transit, database row-level isolation and audit logging. No method of transmission or storage is completely secure.</P> },
  { heading: 'Data Retention', body: <P>We retain information for as long as an account is active and as needed for legal, accounting and security purposes. <Fill label="Retention periods" /></P> },
  { heading: 'Data Access, Correction, and Deletion', body: <P>You may request access to, correction of, or deletion of your personal information by contacting <Fill label="Privacy contact email" />.</P> },
  { heading: 'Marketing Communications', body: <P>You can opt out of marketing emails at any time. Transactional and account emails are required to operate the service.</P> },
  { heading: "Children's Privacy", body: <P>The service is not directed to children and is intended for business use.</P> },
  { heading: 'International Data Transfers', body: <P><Fill label="Hosting regions and transfer mechanism" /></P> },
  { heading: 'Changes to This Privacy Policy', body: <P>We may update this policy and will post the revised version with a new effective date.</P> },
  { heading: 'Contact Information', body: <P>Questions: <Fill label="Privacy contact email" />. Business address: <Fill label="Business address" />.</P> },
];

export default function PrivacyPage() {
  return <LegalDoc title="Privacy Policy" sections={sections} />;
}
