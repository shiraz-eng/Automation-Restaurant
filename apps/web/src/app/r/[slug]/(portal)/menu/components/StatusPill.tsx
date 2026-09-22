import { AlertTriangle, Ban, CheckCircle2, XCircle } from 'lucide-react';
import { STATUS_LABEL, type AvailabilityStatus } from '../menuTypes';

const TONE: Record<AvailabilityStatus, string> = {
  available: 'text-ok bg-ok/10 border-ok/30',
  unavailable: 'text-muted bg-main border-border',
  sold_out: 'text-danger bg-danger/10 border-danger/30',
  low_stock: 'text-warn bg-warn/10 border-warn/30',
  out_of_stock: 'text-danger bg-danger/10 border-danger/30',
};
const ICON: Record<AvailabilityStatus, typeof CheckCircle2> = {
  available: CheckCircle2,
  unavailable: Ban,
  sold_out: XCircle,
  low_stock: AlertTriangle,
  out_of_stock: XCircle,
};

/** Status is never color-only — an icon + the word itself always ships
 *  together, so it reads correctly for colorblind users too. */
export function StatusPill({ status }: { status: AvailabilityStatus }) {
  const Icon = ICON[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE[status]}`}>
      <Icon size={11} />
      {STATUS_LABEL[status]}
    </span>
  );
}
