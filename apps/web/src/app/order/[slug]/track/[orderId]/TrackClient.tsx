'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createTenantBrowserClient } from '@/lib/supabase/tenant-client';
import { formatCents } from '@/lib/format';

type Line = { name_snapshot: string; qty: number; line_total_cents: number };
export type TrackedOrder = {
  id: string;
  order_number: number;
  table_label: string | null;
  customer_name: string | null;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  created_at: string;
  order_lines: Line[];
};

const STEPS = [
  { key: 'placed', label: 'Order placed' },
  { key: 'kitchen', label: 'In the kitchen' },
  { key: 'ready', label: 'Ready' },
  { key: 'served', label: 'Served' },
] as const;

function stepIndex(status: string): number {
  switch (status) {
    case 'served':
    case 'paid':
      return 3;
    case 'ready':
      return 2;
    case 'in_kitchen':
    case 'pending':
      return 1;
    default:
      return 0;
  }
}

// Optional categories collected alongside the required overall rating —
// matches the columns the restaurant actually reads back (aiTools.ts'
// get_customer_feedback, the same set the AI assistant reports on).
const CATEGORIES = [
  { key: 'food', label: 'Food' },
  { key: 'service', label: 'Service' },
  { key: 'speed', label: 'Speed' },
  { key: 'cleanliness', label: 'Cleanliness' },
  { key: 'ambiance', label: 'Ambiance' },
] as const;
type CategoryKey = (typeof CATEGORIES)[number]['key'];

function Stars({
  value,
  onChange,
  size = 'text-2xl',
}: {
  value: number;
  onChange: (n: number) => void;
  size?: string;
}) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          className={`${size} leading-none ${n <= value ? 'text-warn' : 'text-muted'}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

export function TrackClient({
  slug,
  restaurantName,
  supabaseUrl,
  supabaseAnonKey,
  initial,
  counters,
  initialCounterId,
}: {
  slug: string;
  restaurantName: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  initial: TrackedOrder;
  counters: { id: string; name: string }[];
  initialCounterId: string | null;
}) {
  const supabase = useMemo(
    () => createTenantBrowserClient(supabaseUrl, supabaseAnonKey),
    [supabaseUrl, supabaseAnonKey],
  );
  const [status, setStatus] = useState(initial.status);
  const [counterId, setCounterId] = useState(initialCounterId);
  const current = stepIndex(status);

  // Live: react to this order's status/counter-assignment changes with no refresh.
  useEffect(() => {
    const channel = supabase
      .channel(`order-${initial.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${initial.id}` },
        (payload) => {
          const row = payload.new as { status?: string; pickup_counter_portal_id?: string | null };
          if (row.status) setStatus(row.status);
          if ('pickup_counter_portal_id' in row) setCounterId(row.pickup_counter_portal_id ?? null);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, initial.id]);

  const [fbOpen, setFbOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [cats, setCats] = useState<Record<CategoryKey, number>>({
    food: 0,
    service: 0,
    speed: 0,
    cleanliness: 0,
    ambiance: 0,
  });
  const [comment, setComment] = useState('');
  const [fbBusy, setFbBusy] = useState(false);
  const [fbDone, setFbDone] = useState(false);
  const [fbErr, setFbErr] = useState<string | null>(null);

  async function sendFeedback() {
    setFbErr(null);
    setFbBusy(true);
    const { error } = await supabase.from('feedback').insert({
      order_id: initial.id,
      table_label: initial.table_label,
      guest_name: initial.customer_name,
      overall: rating,
      // Only send a category the guest actually rated — leave the rest null
      // rather than recording a false "1 star" for something unrated.
      food: cats.food || null,
      service: cats.service || null,
      speed: cats.speed || null,
      cleanliness: cats.cleanliness || null,
      ambiance: cats.ambiance || null,
      comment: comment.trim() || null,
    });
    setFbBusy(false);
    if (error) {
      setFbErr(error.message);
      return;
    }
    setFbDone(true);
  }

  const assignedCounterName = counters.find((c) => c.id === counterId)?.name ?? null;
  const readyForCounter = status === 'ready' && (assignedCounterName != null || counters.length > 0);

  return (
    <div className="min-h-screen px-6 py-8 max-w-md mx-auto">
      <h1 className="font-black text-lg">Order #{initial.order_number}</h1>
      <p className="text-muted text-xs mb-6">
        {restaurantName} · {initial.table_label ?? 'no table'}
        {initial.customer_name ? ` · ${initial.customer_name}` : ''}
      </p>

      <ol className="space-y-3 mb-6">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={s.key} className="flex items-center gap-3">
              <span
                className={`w-5 h-5 rounded-full grid place-items-center text-[10px] font-black ${
                  done
                    ? 'bg-ok text-white'
                    : active
                      ? 'bg-primary text-primary-fg'
                      : 'border border-border text-muted'
                }`}
              >
                {done ? '✓' : ''}
              </span>
              <span
                className={`text-sm ${active ? 'font-bold text-body' : done ? 'text-body' : 'text-muted'}`}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {readyForCounter && (
        <div className="rounded-lg border border-primary/40 bg-primary/5 p-4 mb-6 text-center">
          <p className="font-bold text-sm">Your order is ready! 🎉</p>
          <p className="text-xs text-muted mt-1">
            Please collect it and pay at{' '}
            {assignedCounterName
              ? assignedCounterName
              : counters.length === 1
                ? counters[0].name
                : `${counters
                    .slice(0, -1)
                    .map((c) => c.name)
                    .join(', ')} or ${counters[counters.length - 1].name}`}
            .
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-4 text-xs space-y-1 mb-6">
        {initial.order_lines.map((l, i) => (
          <div key={i} className="flex justify-between">
            <span>
              {l.qty}× {l.name_snapshot}
            </span>
            <span className="font-semibold">{formatCents(l.line_total_cents)}</span>
          </div>
        ))}
        <div className="flex justify-between pt-1 border-t border-border mt-1 text-muted">
          <span>tax {formatCents(initial.tax_cents)}</span>
          <span className="text-body font-bold">total {formatCents(initial.total_cents)}</span>
        </div>
      </div>

      <Link
        href={`/order/${slug}?table=${encodeURIComponent(initial.table_label ?? '')}`}
        className="block text-center rounded border border-border font-semibold py-2.5 text-sm mb-4"
      >
        Order more items
      </Link>

      {current >= 3 && !fbDone && (
        <div className="rounded-lg border border-border bg-surface p-4">
          {!fbOpen ? (
            <button
              onClick={() => setFbOpen(true)}
              className="w-full rounded bg-primary text-primary-fg font-bold py-2.5 text-sm"
            >
              Rate your experience
            </button>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted mb-1">Overall</p>
                <Stars value={rating} onChange={setRating} />
              </div>
              <div className="space-y-2 pt-1 border-t border-border">
                <p className="text-[11px] text-muted">Anything specific? (optional)</p>
                {CATEGORIES.map((c) => (
                  <div key={c.key} className="flex items-center justify-between">
                    <span className="text-xs">{c.label}</span>
                    <Stars
                      value={cats[c.key]}
                      onChange={(n) => setCats((p) => ({ ...p, [c.key]: n }))}
                      size="text-base"
                    />
                  </div>
                ))}
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Tell us about your experience"
                className="w-full rounded border border-border bg-main px-3 py-2 text-xs outline-none focus:border-primary"
                rows={3}
              />
              {fbErr && <p className="text-danger text-xs">{fbErr}</p>}
              <button
                onClick={sendFeedback}
                disabled={fbBusy}
                className="w-full rounded bg-primary text-primary-fg font-bold py-2.5 text-sm disabled:opacity-50"
              >
                {fbBusy ? 'Sending…' : 'Submit feedback'}
              </button>
            </div>
          )}
        </div>
      )}
      {fbDone && <p className="text-ok text-sm text-center">Thanks for the feedback!</p>}
    </div>
  );
}
