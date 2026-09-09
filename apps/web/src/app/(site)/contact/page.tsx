import { ContactForm } from './ContactForm';

export const metadata = { title: 'Contact — Automation Restaurant' };

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl px-5 py-20">
      <h1 className="text-3xl font-black">Talk to our team</h1>
      <p className="text-muted mt-2 mb-8 text-sm">
        Questions about plans, onboarding, or whether Automation Restaurant fits your operation?
        Send us a note.
      </p>
      <ContactForm />
    </div>
  );
}
