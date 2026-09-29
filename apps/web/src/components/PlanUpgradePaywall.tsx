import Link from 'next/link';
import { Card, Button } from '@/components/ui';
import { FEATURE_METADATA, type FeatureKey } from '@automation-restaurant/shared';

export function PlanUpgradePaywall({
  slug,
  featureKey,
  currentTier,
  customTitle,
  customDescription,
}: {
  slug: string;
  featureKey: FeatureKey;
  currentTier?: string | null;
  customTitle?: string;
  customDescription?: string;
}) {
  const meta = FEATURE_METADATA[featureKey];
  const title = customTitle || meta?.name || 'Premium Feature';
  const requiredPlan = meta?.minTierName || 'Professional';
  const description =
    customDescription ||
    meta?.description ||
    'Upgrade your subscription plan to unlock this capability across all your staff terminals and portals.';

  return (
    <div className="max-w-2xl mx-auto py-12 px-4 sm:px-6">
      <Card className="p-8 text-center space-y-6 border border-border shadow-xl bg-surface relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-primary via-indigo-500 to-purple-600" />

        <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-2xl shadow-inner">
          🔒
        </div>

        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-main border border-border text-[11px] font-bold text-muted uppercase tracking-wider">
            <span>Plan Requirement</span>
            <span>•</span>
            <span className="text-primary font-bold">{requiredPlan} Plan</span>
          </div>
          <h1 className="text-2xl font-black text-body tracking-tight">{title}</h1>
          <p className="text-muted text-sm max-w-lg mx-auto leading-relaxed">{description}</p>
        </div>

        <div className="p-4 rounded-xl bg-main/50 border border-border/60 text-left text-xs space-y-2.5 max-w-md mx-auto">
          <div className="font-bold text-body text-[11px] uppercase tracking-wide text-muted">
            Included with {requiredPlan}:
          </div>
          {featureKey === 'kds.realtime' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Real-time kitchen order tickets &amp; live timers</span></li>
              <li className="flex items-center gap-2">✓ <span>Course pacing &amp; prep status coordination</span></li>
              <li className="flex items-center gap-2">✓ <span>Kitchen history &amp; order recall log</span></li>
            </ul>
          )}
          {featureKey === 'inventory.recipe_deduction' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Live stock ledger &amp; unit tracking</span></li>
              <li className="flex items-center gap-2">✓ <span>Recipe-based automatic ingredient deduction</span></li>
              <li className="flex items-center gap-2">✓ <span>Supplier directory &amp; purchase order management</span></li>
              <li className="flex items-center gap-2">✓ <span>Theoretical food cost analysis</span></li>
            </ul>
          )}
          {featureKey === 'staff.management' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Full staff directory &amp; custom roles</span></li>
              <li className="flex items-center gap-2">✓ <span>Weekly shift scheduling &amp; rosters</span></li>
              <li className="flex items-center gap-2">✓ <span>Clock-in/out attendance tracking</span></li>
              <li className="flex items-center gap-2">✓ <span>Customer reviews &amp; feedback monitoring</span></li>
            </ul>
          )}
          {featureKey === 'accounting.finance' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Authoritative Profit &amp; Loss (P&amp;L) waterfall</span></li>
              <li className="flex items-center gap-2">✓ <span>Operating expenses breakdown by category</span></li>
              <li className="flex items-center gap-2">✓ <span>Net margin &amp; food cost calculations</span></li>
              <li className="flex items-center gap-2">✓ <span>Exportable vector PDF financial reports</span></li>
            </ul>
          )}
          {featureKey === 'portals.advanced' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Custom station portals (Kitchen, Bar, Waiter)</span></li>
              <li className="flex items-center gap-2">✓ <span>Independent PIN &amp; password protection</span></li>
              <li className="flex items-center gap-2">✓ <span>Station-level access restriction &amp; isolation</span></li>
            </ul>
          )}
          {featureKey === 'analytics.advanced' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>16-sheet Excel workbook export generator</span></li>
              <li className="flex items-center gap-2">✓ <span>AI business assistant &amp; operations analysis</span></li>
              <li className="flex items-center gap-2">✓ <span>Comprehensive administrative audit log</span></li>
            </ul>
          )}
          {featureKey === 'menu.branded' && (
            <ul className="space-y-1.5 text-muted">
              <li className="flex items-center gap-2">✓ <span>Upload custom restaurant logo</span></li>
              <li className="flex items-center gap-2">✓ <span>Custom brand colors across portals &amp; menus</span></li>
              <li className="flex items-center gap-2">✓ <span>Customized receipt templates &amp; footer notes</span></li>
              <li className="flex items-center gap-2">✓ <span>Custom browser meta titles &amp; favicons</span></li>
            </ul>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <Link href={`/r/${slug}/billing`} className="w-full sm:w-auto">
            <Button variant="primary" className="w-full sm:w-auto py-2.5 px-6 font-bold shadow-md">
              Upgrade to {requiredPlan} →
            </Button>
          </Link>
          <a
            href="/pricing"
            target="_blank"
            rel="noreferrer"
            className="w-full sm:w-auto text-xs font-semibold text-muted hover:text-body py-2 px-4 rounded-lg border border-border bg-main/50 hover:bg-main transition-colors text-center"
          >
            Compare All Plans ↗
          </a>
        </div>

        <p className="text-[11px] text-muted">
          Your current plan is <strong className="capitalize text-body">{currentTier || 'Starter'}</strong>. Upgrades apply immediately with no service interruption.
        </p>
      </Card>
    </div>
  );
}
