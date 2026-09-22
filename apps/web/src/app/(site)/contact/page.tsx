import { ContactForm } from './ContactForm';

export const metadata = { title: 'Contact', description: 'Talk to the Automation Restaurant team about plans, onboarding, or whether the platform fits your restaurant.' };

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl px-5 md:px-8 py-20 md:py-28">
      <span className="inline-flex items-center gap-2 rounded-full border border-black/15 bg-black/[0.04] px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-black">
        Book a demo
      </span>
      <h1 className="font-display text-3xl md:text-4xl font-bold tracking-tight mt-4">Talk to our team</h1>
      <p className="text-muted mt-2 mb-8 text-sm">
        Questions about plans, onboarding, or whether Automation Restaurant fits your operation?
        Send us a note and we&rsquo;ll reply by email.
      </p>
      <ContactForm />
    </div>
  );
}
