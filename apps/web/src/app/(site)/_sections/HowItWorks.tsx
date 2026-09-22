import { Section } from '@/components/marketing/Section';
import { Reveal } from '@/components/marketing/Reveal';

const STEPS = [
  { n: '01', title: 'Create your restaurant', text: 'Sign up and your restaurant workspace is provisioned automatically.' },
  { n: '02', title: 'Configure your team and portals', text: 'Add staff and build custom portals from individual permissions.' },
  { n: '03', title: 'Connect your operations', text: 'Menu, recipes, inventory and suppliers set up in one place.' },
  { n: '04', title: 'Run everything from one system', text: 'Orders, kitchen, finance and analytics, all connected from day one.' },
];

export function HowItWorks() {
  return (
    <Section eyebrow="How it works" title="From sign-up to running service">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 70}>
            <div>
              <div className="font-display text-3xl font-bold text-black/20">{s.n}</div>
              <div className="font-display font-bold text-[15px] mt-2">{s.title}</div>
              <p className="text-muted text-sm mt-1.5 leading-relaxed">{s.text}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
