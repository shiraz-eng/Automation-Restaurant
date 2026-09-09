'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Restaurant picker. Each restaurant has its own portal at /r/<slug>. */
export default function PickRestaurant() {
  const router = useRouter();
  const [slug, setSlug] = useState('');

  function go(e: React.FormEvent) {
    e.preventDefault();
    const s = slug
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '');
    if (s) router.push(`/r/${s}/login`);
  }

  return (
    <div className="min-h-screen grid place-items-center px-4">
      <form onSubmit={go} className="w-full max-w-sm">
        <div className="font-black text-xl mb-1">
          Automation<span className="text-primary">.</span>
        </div>
        <p className="text-muted mb-8">Enter your restaurant to sign in.</p>

        <label className="block">
          <span className="text-muted text-xs font-semibold">Restaurant handle</span>
          <input
            autoFocus
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="the-gourmet-kitchen"
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 outline-none focus:border-primary"
          />
        </label>

        <button
          type="submit"
          className="w-full mt-4 rounded bg-primary text-primary-fg font-semibold py-2.5"
        >
          Continue
        </button>
      </form>
    </div>
  );
}
