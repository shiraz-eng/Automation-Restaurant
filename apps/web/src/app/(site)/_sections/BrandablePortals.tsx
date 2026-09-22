import { FileText, Globe, Mail, Palette } from 'lucide-react';
import { Section } from '@/components/marketing/Section';
import { FlowVertical } from '@/components/marketing/FlowVertical';
import { Reveal } from '@/components/marketing/Reveal';

const POINTS = [
  { icon: Palette, title: 'Your brand', text: 'Logo and colors applied across every portal, screen and login.' },
  { icon: Globe, title: 'Your portal identity', text: 'A branded portal name, page titles and favicon — not the platform’s.' },
  { icon: FileText, title: 'Your documents', text: 'Receipts, invoices and PDF reports carry your restaurant’s identity.' },
  { icon: Mail, title: 'Your email identity', text: 'Operational emails show your restaurant’s name, not a generic sender.' },
];

export function BrandablePortals() {
  return (
    <Section
      eyebrow="Branding"
      title="Every restaurant gets its own branded experience."
      subtitle="Set it once in Brand Kit, and it carries through the entire platform — every portal, every document, every email."
    >
      <div className="grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr]">
        <Reveal>
          <div className="grid gap-4 sm:grid-cols-2">
            {POINTS.map((p) => (
              <div key={p.title} className="rounded-2xl border border-border bg-surface p-5">
                <p.icon size={18} className="text-black" strokeWidth={2} />
                <div className="font-display font-bold text-sm mt-3">{p.title}</div>
                <p className="text-muted text-xs mt-1 leading-relaxed">{p.text}</p>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal delay={100}>
          <div className="rounded-2xl border border-border bg-surface p-6 md:p-8">
            <FlowVertical
              steps={[
                { label: 'Your restaurant' },
                { label: 'Your brand', detail: 'Logo, colors, favicon' },
                { label: 'Your portals', detail: 'Owner, staff and kiosk portals' },
                { label: 'Your documents', detail: 'Receipts, invoices, PDF reports' },
                { label: 'Your emails', detail: 'Sent under your restaurant’s identity' },
              ]}
            />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
