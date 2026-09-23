'use client';

import { AdminField, AdminInput, AdminTextarea } from '../../_components/ui';
import type { HeroContent, FlatListContent, CopyOnlyContent, CtaContent } from '@/lib/cms/schemas';

function linesToArray(text: string): string[] {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function HeroFields({ content, onChange }: { content: HeroContent; onChange: (c: HeroContent) => void }) {
  const c = content;
  return (
    <>
      <AdminField label="Badge">
        <AdminInput value={c.badge} onChange={(e) => onChange({ ...c, badge: e.target.value })} />
      </AdminField>
      <AdminField label="Headline">
        <AdminInput value={c.headline} onChange={(e) => onChange({ ...c, headline: e.target.value })} />
      </AdminField>
      <AdminField label="Subhead">
        <AdminTextarea rows={2} value={c.subhead} onChange={(e) => onChange({ ...c, subhead: e.target.value })} />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Primary button label">
          <AdminInput value={c.primaryCta.label} onChange={(e) => onChange({ ...c, primaryCta: { ...c.primaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Primary button link">
          <AdminInput value={c.primaryCta.href} onChange={(e) => onChange({ ...c, primaryCta: { ...c.primaryCta, href: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button label">
          <AdminInput value={c.secondaryCta.label} onChange={(e) => onChange({ ...c, secondaryCta: { ...c.secondaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button link">
          <AdminInput value={c.secondaryCta.href} onChange={(e) => onChange({ ...c, secondaryCta: { ...c.secondaryCta, href: e.target.value } })} />
        </AdminField>
      </div>
      <AdminField label="Connected modules (one per line)">
        <AdminTextarea rows={4} value={c.connects.join('\n')} onChange={(e) => onChange({ ...c, connects: linesToArray(e.target.value) })} />
      </AdminField>
      <AdminField label="Hero image URL">
        <AdminInput value={c.image.src} onChange={(e) => onChange({ ...c, image: { ...c.image, src: e.target.value } })} />
      </AdminField>
      <AdminField label="Hero image alt text">
        <AdminInput value={c.image.alt} onChange={(e) => onChange({ ...c, image: { ...c.image, alt: e.target.value } })} />
      </AdminField>
      <AdminField label="Kitchen Display card — tickets (table|status, one per line)">
        <AdminTextarea
          rows={4}
          value={c.kitchenTickets.map((t) => `${t.table}|${t.status}`).join('\n')}
          onChange={(e) =>
            onChange({
              ...c,
              kitchenTickets: linesToArray(e.target.value).map((l) => {
                const [table, status] = l.split('|');
                return { table: (table ?? '').trim(), status: (status ?? '').trim() };
              }),
            })
          }
        />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Inventory alert — title">
          <AdminInput value={c.inventoryAlert.title} onChange={(e) => onChange({ ...c, inventoryAlert: { ...c.inventoryAlert, title: e.target.value } })} />
        </AdminField>
        <AdminField label="Inventory alert — text">
          <AdminInput value={c.inventoryAlert.text} onChange={(e) => onChange({ ...c, inventoryAlert: { ...c.inventoryAlert, text: e.target.value } })} />
        </AdminField>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <AdminField label="AI card — title">
          <AdminInput value={c.aiRecommendation.title} onChange={(e) => onChange({ ...c, aiRecommendation: { ...c.aiRecommendation, title: e.target.value } })} />
        </AdminField>
        <AdminField label="AI card — text">
          <AdminInput value={c.aiRecommendation.text} onChange={(e) => onChange({ ...c, aiRecommendation: { ...c.aiRecommendation, text: e.target.value } })} />
        </AdminField>
        <AdminField label="AI card — link text">
          <AdminInput value={c.aiRecommendation.linkText} onChange={(e) => onChange({ ...c, aiRecommendation: { ...c.aiRecommendation, linkText: e.target.value } })} />
        </AdminField>
      </div>
    </>
  );
}

export function FlatListFields({ content, onChange }: { content: FlatListContent; onChange: (c: FlatListContent) => void }) {
  return (
    <>
      <AdminField label="Heading">
        <AdminInput value={content.heading} onChange={(e) => onChange({ ...content, heading: e.target.value })} />
      </AdminField>
      <AdminField label="Items (one per line)">
        <AdminTextarea rows={6} value={content.items.join('\n')} onChange={(e) => onChange({ ...content, items: linesToArray(e.target.value) })} />
      </AdminField>
    </>
  );
}

export function CopyOnlyFields({ content, onChange }: { content: CopyOnlyContent; onChange: (c: CopyOnlyContent) => void }) {
  return (
    <>
      <AdminField label="Eyebrow">
        <AdminInput value={content.eyebrow} onChange={(e) => onChange({ ...content, eyebrow: e.target.value })} />
      </AdminField>
      <AdminField label="Title">
        <AdminInput value={content.title} onChange={(e) => onChange({ ...content, title: e.target.value })} />
      </AdminField>
      <AdminField label="Subtitle">
        <AdminTextarea rows={2} value={content.subtitle} onChange={(e) => onChange({ ...content, subtitle: e.target.value })} />
      </AdminField>
    </>
  );
}

export function CtaFields({ content, onChange }: { content: CtaContent; onChange: (c: CtaContent) => void }) {
  const c = content;
  return (
    <>
      <AdminField label="Headline">
        <AdminInput value={c.headline} onChange={(e) => onChange({ ...c, headline: e.target.value })} />
      </AdminField>
      <AdminField label="Subtext">
        <AdminTextarea rows={2} value={c.subtext} onChange={(e) => onChange({ ...c, subtext: e.target.value })} />
      </AdminField>
      <div className="grid grid-cols-2 gap-3">
        <AdminField label="Primary button label">
          <AdminInput value={c.primaryCta.label} onChange={(e) => onChange({ ...c, primaryCta: { ...c.primaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Primary button link">
          <AdminInput value={c.primaryCta.href} onChange={(e) => onChange({ ...c, primaryCta: { ...c.primaryCta, href: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button label">
          <AdminInput value={c.secondaryCta.label} onChange={(e) => onChange({ ...c, secondaryCta: { ...c.secondaryCta, label: e.target.value } })} />
        </AdminField>
        <AdminField label="Secondary button link">
          <AdminInput value={c.secondaryCta.href} onChange={(e) => onChange({ ...c, secondaryCta: { ...c.secondaryCta, href: e.target.value } })} />
        </AdminField>
      </div>
    </>
  );
}

export function FaqCopyFields({ content, onChange }: { content: { eyebrow: string; title: string }; onChange: (c: { eyebrow: string; title: string }) => void }) {
  return (
    <>
      <AdminField label="Eyebrow">
        <AdminInput value={content.eyebrow} onChange={(e) => onChange({ ...content, eyebrow: e.target.value })} />
      </AdminField>
      <AdminField label="Title">
        <AdminInput value={content.title} onChange={(e) => onChange({ ...content, title: e.target.value })} />
      </AdminField>
      <p className="text-[11px] text-ink-muted">The FAQ questions themselves are managed separately under CMS &rarr; FAQ.</p>
    </>
  );
}
