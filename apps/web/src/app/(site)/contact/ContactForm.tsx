'use client';

import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [restaurant, setRestaurant] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/public/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          restaurant: restaurant.trim() || undefined,
          message: message.trim(),
        }),
      });
      if (!res.ok) {
        setError('Could not send your message. Try again.');
        return;
      }
      setDone(true);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-ok/40 bg-ok/10 p-6 text-sm text-ok font-medium">
        Thanks — we&apos;ve got your message and will be in touch.
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Your name">
        <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Email">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputCls}
        />
      </Field>
      <Field label="Restaurant (optional)">
        <input value={restaurant} onChange={(e) => setRestaurant(e.target.value)} className={inputCls} />
      </Field>
      <Field label="Message">
        <textarea
          required
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={inputCls}
        />
      </Field>
      {error && <p className="text-danger text-xs">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full sm:w-auto rounded-lg bg-black text-white font-bold px-6 py-3 text-sm transition-transform hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
      >
        {busy ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}

const inputCls =
  'mt-1.5 w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-black focus:ring-2 focus:ring-black/10';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted text-xs font-semibold">{label}</span>
      {children}
    </label>
  );
}
