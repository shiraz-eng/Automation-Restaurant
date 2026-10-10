'use client';

import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortalSupabase } from '@/components/PortalProvider';
import { Button, Card, Input, Select } from '@/components/ui';
import { formatCents, formatDateTime } from '@/lib/format';
import { downloadReceiptPdf } from '@/lib/generateReceipt';
import { DEFAULT_RECEIPT_CONFIG, type ReceiptConfig, type ReceiptContext } from '@/lib/receiptTemplate';
import { downloadKotTicket } from '@/lib/generateKotTicket';

// Kitchen-stage progression only. "paid" is reached exclusively through
// record_payment (Checkout) so it always carries a real payment and a
// paid_at timestamp; "void" goes through cancel_order below, which is
// audited and refuses to cancel an already-paid order. Editing either
// directly here used to let staff mark an order "paid" with $0 collected —
// see the Cancel button for the replacement void path.
const EDITABLE_STATUSES = ['pending', 'in_kitchen', 'ready', 'served'] as const;
const TERMINAL_LABEL: Record<string, string> = { paid: 'Paid', void: 'Void' };

const STATUS_FILTERS: [string, string, (s: string) => boolean][] = [
  ['all', 'All', () => true],
  ['open', 'Open', (s) => s === 'pending' || s === 'in_kitchen' || s === 'ready'],
  ['served', 'Served', (s) => s === 'served'],
  ['paid', 'Paid', (s) => s === 'paid'],
  ['void', 'Void', (s) => s === 'void'],
];
type SortKey = 'time' | 'number' | 'total' | 'items' | 'status';
type SortDir = 'asc' | 'desc';
// Kitchen-to-paid order, so sorting by status follows how far along an order is.
const STATUS_RANK: Record<string, number> = { pending: 0, in_kitchen: 1, ready: 2, served: 3, paid: 4, void: 5 };

type Line = {
  name_snapshot: string;
  variant_name_snapshot?: string | null;
  qty: number;
  unit_price_cents?: number;
  line_total_cents: number;
  kds_status: string;
  modifiers?: string[] | null;
  customer_note?: string | null;
};

type Payment = {
  method: string;
  amount_cents: number;
  reference?: string | null;
  status?: string;
};

export type Order = {
  id: string;
  order_number: number;
  status: string;
  channel: string;
  table_label: string | null;
  customer_name: string | null;
  subtotal_cents: number;
  discount_cents?: number;
  tax_cents: number;
  total_cents: number;
  refunded_cents?: number;
  paid_at?: string | null;
  created_at: string;
  order_lines: Line[];
  payments?: Payment[];
  /** Multi-branch, All branches view: the branch the order belongs to. */
  branch_name?: string | null;
};

export function OrdersClient({
  orders,
  restaurantName,
  receiptConfig,
  brandKit,
  restaurantInfo,
  canCancel,
  canUpdateStatus,
  canReopen = false,
}: {
  orders: Order[];
  restaurantName?: string;
  receiptConfig?: ReceiptConfig | null;
  brandKit?: { logoUrl?: string | null; primaryColor?: string | null };
  restaurantInfo?: { address?: string | null; phone?: string | null; taxId?: string | null; taxRateBps?: number };
  canCancel: boolean;
  /** orders.update — matches the orders table's staff_update RLS policy. */
  canUpdateStatus: boolean;
  /** orders.reopen — reopen_order() moves a served/paid order back to ready. */
  canReopen?: boolean;
}) {
  const router = useRouter();
  const supabase = usePortalSupabase();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'time', dir: 'desc' });

  const channels = useMemo(() => [...new Set(orders.map((o) => o.channel).filter(Boolean))].sort(), [orders]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const statusOk = STATUS_FILTERS.find(([k]) => k === statusFilter)?.[2] ?? (() => true);
    const value = (o: Order): number | string => {
      switch (sort.key) {
        case 'number':
          return o.order_number;
        case 'total':
          return o.total_cents;
        case 'items':
          return o.order_lines?.length ?? 0;
        case 'status':
          return STATUS_RANK[o.status] ?? 9;
        default:
          return o.created_at;
      }
    };
    return orders
      .filter((o) => statusOk(o.status))
      .filter((o) => channelFilter === 'all' || o.channel === channelFilter)
      .filter(
        (o) =>
          !q ||
          String(o.order_number).includes(q) ||
          (o.table_label ?? '').toLowerCase().includes(q) ||
          (o.customer_name ?? '').toLowerCase().includes(q) ||
          (o.order_lines ?? []).some((l) => l.name_snapshot.toLowerCase().includes(q)),
      )
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : a.order_number - b.order_number;
        return sort.dir === 'asc' ? cmp : -cmp;
      });
  }, [orders, search, statusFilter, channelFilter, sort]);

  function sortBy(key: SortKey) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'number' || key === 'status' ? 'asc' : 'desc' },
    );
  }
  function sortHeader(key: SortKey, label: string, right = false) {
    const active = sort.key === key;
    return (
      <th
        className={`p-3 font-semibold ${right ? 'text-right' : ''}`}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" onClick={() => sortBy(key)} className={`hover:text-body ${active ? 'text-body' : ''}`}>
          {label}
          {active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
        </button>
      </th>
    );
  }

  async function setStatus(id: string, status: string) {
    setSavingId(id);
    setError(null);
    // order_lines.kds_status is kept in sync with this write by a database
    // trigger (0051_order_status_line_sync.sql) — added because this page's
    // direct status write (orders.update permission) and the Kitchen
    // board's kitchen_* RPCs (kitchen.update_status permission) are two
    // different, independently-permissioned paths to the same field, and
    // only fixing the frontend here would silently break status changes
    // for any custom portal granted one permission but not the other.
    const { error } = await supabase.from('orders').update({ status }).eq('id', id);
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function cancel(order: Order) {
    const reason = window.prompt(`Cancel order #${order.order_number}. Reason:`);
    if (!reason) return;
    setSavingId(order.id);
    setError(null);
    const { error } = await supabase.rpc('cancel_order', { p_order_id: order.id, p_reason: reason });
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function reopen(order: Order) {
    const reason = window.prompt(`Reopen order #${order.order_number}. Reason:`);
    if (!reason) return;
    setSavingId(order.id);
    setError(null);
    const { error } = await supabase.rpc('reopen_order', { p_order_id: order.id, p_reason: reason });
    setSavingId(null);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  async function handleDownloadReceipt(order: Order) {
    try {
      const successfulPayment = (order.payments ?? []).find((p) => p.status === 'succeeded' || !p.status) ?? order.payments?.[0];
      const ctx: ReceiptContext = {
        restaurantName: restaurantName || 'Restaurant',
        logoUrl: brandKit?.logoUrl ?? null,
        primaryColor: brandKit?.primaryColor ?? null,
        address: restaurantInfo?.address ?? null,
        phone: restaurantInfo?.phone ?? null,
        email: null,
        website: null,
        taxId: restaurantInfo?.taxId ?? null,
        orderNumber: order.order_number,
        tableLabel: order.table_label,
        customerName: order.customer_name,
        orderType: order.channel?.replace('_', ' ') ?? 'dine-in',
        createdAt: order.created_at,
        paidAt: order.paid_at ?? null,
        orderStatus: order.status,
        lines: (order.order_lines ?? []).map((l) => ({
          name: l.name_snapshot,
          variantName: l.variant_name_snapshot ?? null,
          qty: l.qty,
          unitPriceCents: l.unit_price_cents ?? (l.qty ? Math.round(l.line_total_cents / l.qty) : l.line_total_cents),
          lineTotalCents: l.line_total_cents,
          modifiers: Array.isArray(l.modifiers)
            ? l.modifiers.map((m: any) => ({ name: typeof m === 'string' ? m : m?.name ?? '', price_cents: typeof m === 'object' ? Number(m?.price_cents ?? 0) : 0 }))
            : undefined,
          notes: l.customer_note ?? null,
        })),
        subtotalCents: order.subtotal_cents,
        discountCents: order.discount_cents ?? 0,
        taxCents: order.tax_cents,
        taxRateBps: restaurantInfo?.taxRateBps ?? 0,
        totalCents: order.total_cents,
        refundedCents: order.refunded_cents ?? 0,
        paymentMethod: successfulPayment?.method ?? (order.status === 'paid' ? 'Paid' : null),
        paymentReference: successfulPayment?.reference ?? null,
        amountPaidCents: successfulPayment?.amount_cents ?? (order.status === 'paid' ? order.total_cents : null),
        changeCents: null,
      };

      const config: ReceiptConfig = receiptConfig ?? DEFAULT_RECEIPT_CONFIG;
      await downloadReceiptPdf(config, ctx);
    } catch (err) {
      console.error('Failed to generate receipt PDF:', err);
      alert('Could not generate receipt PDF. Please try again.');
    }
  }

  function handleDownloadKot(order: Order) {
    try {
      downloadKotTicket({
        restaurantName: restaurantName || 'Restaurant',
        kotNumber: order.order_number,
        orderNumber: order.order_number,
        channel: order.channel,
        tableLabel: order.table_label,
        createdAt: order.created_at,
        orderNote: null,
        lines: (order.order_lines ?? []).map((l) => ({
          name: l.name_snapshot,
          variantName: l.variant_name_snapshot ?? null,
          qty: l.qty,
          modifiers: Array.isArray(l.modifiers) ? l.modifiers.map((m) => (typeof m === 'string' ? m : (m as any)?.name ?? '')) : undefined,
          note: l.customer_note ?? undefined,
        })),
      });
    } catch (err) {
      console.error('Failed to generate KOT ticket:', err);
      alert('Could not generate KOT ticket.');
    }
  }

  if (orders.length === 0) return <Card>No orders yet.</Card>;

  return (
    <Card className="p-0 overflow-hidden">
      {error && <div className="bg-danger/10 text-danger text-xs p-3">{error}</div>}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border text-xs">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search order #, table, customer or dish"
          aria-label="Search orders"
          className="w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
          {STATUS_FILTERS.map(([key, label, test]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              className={`rounded-full border px-2.5 py-1 ${
                statusFilter === key ? 'border-primary bg-primary text-primary-fg' : 'border-border text-muted'
              }`}
            >
              {label} <span className="opacity-70">({orders.filter((o) => test(o.status)).length})</span>
            </button>
          ))}
        </div>
        {channels.length > 1 && (
          <Select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Filter by order type">
            <option value="all">All order types</option>
            {channels.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={`${sort.key}:${sort.dir}`}
          onChange={(e) => {
            const [key, dir] = e.target.value.split(':') as [SortKey, SortDir];
            setSort({ key, dir });
          }}
          aria-label="Sort orders"
        >
          <option value="time:desc">Newest first</option>
          <option value="time:asc">Oldest first</option>
          <option value="total:desc">Total: high to low</option>
          <option value="total:asc">Total: low to high</option>
          <option value="number:desc">Order #: high to low</option>
          <option value="number:asc">Order #: low to high</option>
          <option value="status:asc">Status: kitchen to paid</option>
          <option value="items:desc">Most items</option>
        </Select>
        <span className="text-muted ml-auto">
          {visible.length} of {orders.length}
        </span>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-muted border-b border-border">
          <tr>
            {sortHeader('number', '#')}
            <th className="p-3 font-semibold">Where</th>
            {sortHeader('items', 'Items')}
            {sortHeader('total', 'Total', true)}
            {sortHeader('status', 'Status')}
            {sortHeader('time', 'Time', true)}
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={6} className="p-6 text-center text-muted">
                No orders match these filters.
              </td>
            </tr>
          )}
          {visible.map((o) => {
            const isTerminal = o.status === 'paid' || o.status === 'void';
            return (
            <Fragment key={o.id}>
              <tr
                className="border-b border-border/60 hover:bg-main/50 cursor-pointer"
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
              >
                <td className="p-3 font-mono font-bold">{o.order_number}</td>
                <td className="p-3 text-muted">
                  {o.branch_name && (
                    <span className="mr-1.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">{o.branch_name}</span>
                  )}
                  {o.table_label ?? o.channel.replace('_', ' ')}
                  {o.customer_name ? ` · ${o.customer_name}` : ''}
                </td>
                <td className="p-3 text-muted">{o.order_lines?.length ?? 0}</td>
                <td className="p-3 text-right font-bold">{formatCents(o.total_cents)}</td>
                <td className="p-3" onClick={(e) => e.stopPropagation()}>
                  {isTerminal ? (
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block rounded px-2 py-1 text-xs font-semibold ${
                          o.status === 'paid' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'
                        }`}
                      >
                        {TERMINAL_LABEL[o.status] ?? o.status}
                      </span>
                      {canReopen && o.status === 'paid' && (
                        <button
                          onClick={() => reopen(o)}
                          disabled={savingId === o.id}
                          className="text-primary text-xs underline shrink-0 disabled:opacity-50"
                        >
                          reopen
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {canUpdateStatus ? (
                        <Select
                          value={o.status}
                          disabled={savingId === o.id}
                          onChange={(e) => setStatus(o.id, e.target.value)}
                        >
                          {EDITABLE_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {s.replace('_', ' ')}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="inline-block rounded px-2 py-1 text-xs font-semibold bg-main text-muted capitalize">
                          {o.status.replace('_', ' ')}
                        </span>
                      )}
                      {canReopen && o.status === 'served' && (
                        <button
                          onClick={() => reopen(o)}
                          disabled={savingId === o.id}
                          className="text-primary text-xs underline shrink-0 disabled:opacity-50"
                        >
                          reopen
                        </button>
                      )}
                      {canCancel && (
                        <button
                          onClick={() => cancel(o)}
                          disabled={savingId === o.id}
                          className="text-danger text-xs underline shrink-0 disabled:opacity-50"
                        >
                          cancel
                        </button>
                      )}
                    </div>
                  )}
                </td>
                <td className="p-3 text-right text-muted">{formatDateTime(o.created_at)}</td>
              </tr>
              {expanded === o.id && (
                <tr className="border-b border-border/60 bg-main/30">
                  <td colSpan={6} className="p-3">
                    <div className="space-y-1">
                      {o.order_lines?.map((l, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span>
                            {l.qty}× {l.name_snapshot}{' '}
                            <span className="text-muted">({l.kds_status})</span>
                          </span>
                          <span className="font-semibold">{formatCents(l.line_total_cents)}</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-xs pt-1 border-t border-border mt-1 text-muted">
                        <span>subtotal {formatCents(o.subtotal_cents)}</span>
                        {o.discount_cents ? <span>discount -{formatCents(o.discount_cents)}</span> : null}
                        <span>tax {formatCents(o.tax_cents)}</span>
                        <span className="text-body font-bold">total {formatCents(o.total_cents)}</span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border mt-2">
                        <div className="flex items-center gap-2">
                          <Button
                            variant="primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadReceipt(o);
                            }}
                            className="text-xs py-1 px-2.5 h-auto"
                          >
                            📄 Download Receipt PDF
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadKot(o);
                            }}
                            className="text-xs py-1 px-2.5 h-auto"
                          >
                            🍳 Print KOT
                          </Button>
                        </div>
                        {o.paid_at && (
                          <span className="text-[11px] text-muted">
                            Paid at {formatDateTime(o.paid_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
