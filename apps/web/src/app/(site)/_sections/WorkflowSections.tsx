import { ChefHat, Megaphone, Truck, UtensilsCrossed, Wallet } from 'lucide-react';
import { WorkflowFeature } from '@/components/marketing/WorkflowFeature';
import { PhotoPanel } from '@/components/marketing/PhotoPanel';
import { PhotoWithMockup } from '@/components/marketing/PhotoWithMockup';

const KDS_TICKETS = [
  { table: 'Table 4', status: 'New' },
  { table: 'Table 9', status: 'Cooking' },
  { table: 'QR · T2', status: 'Late' },
];
const KDS_STATUS_CLS: Record<string, string> = { New: 'bg-white/15 text-ink-fg', Cooking: 'bg-warn/25 text-warn', Late: 'bg-danger/25 text-danger' };

export function OperationsKitchenSection() {
  return (
    <WorkflowFeature
      id="operations"
      eyebrow="Operations & Kitchen"
      icon={ChefHat}
      title="Every order, from the till to the pass."
      description="An order placed anywhere — POS, cashier, or a guest scanning a table QR code — reaches the kitchen the moment it's placed, and its status flows back the other way just as fast."
      highlights={[
        'One order queue for POS, cashier and QR/table ordering',
        'Real-time Kitchen Display with a clear prep workflow',
        'Order status stays in sync across kitchen, till and floor',
      ]}
      connectsWith="Inventory (consumption), Finance (revenue), Analytics (sales)."
      flow={[
        { label: 'Order placed' },
        { label: 'Enters Operations', detail: 'POS, cashier or QR ordering' },
        { label: 'Kitchen Display', detail: 'Ticket appears in real time' },
        { label: 'Preparation', detail: 'Status updates as it cooks' },
        { label: 'Completion', detail: 'Ready for pickup or service' },
      ]}
      visual={
        <PhotoWithMockup src="/images/kitchen-hero.jpg" alt="A chef working the line in a busy restaurant kitchen">
          <div className="p-3">
            <div className="flex items-center justify-between text-[10px] font-bold mb-1.5">
              Kitchen Display
              <span className="rounded-full bg-ok/20 text-ok px-1.5 py-0.5 text-[8.5px]">Live</span>
            </div>
            <ul className="space-y-1">
              {KDS_TICKETS.map((t) => (
                <li key={t.table} className="flex items-center justify-between text-[10px]">
                  <span className="text-ink-muted">{t.table}</span>
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${KDS_STATUS_CLS[t.status]}`}>{t.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </PhotoWithMockup>
      }
    />
  );
}

export function InventoryRecipesSection() {
  return (
    <WorkflowFeature
      id="inventory"
      eyebrow="Inventory, Recipes & Food Cost"
      icon={UtensilsCrossed}
      title="Know exactly what every dish costs — and what's left in stock."
      description="Recipes define what a dish consumes. Every sale deducts real ingredients from real stock, so food cost and inventory levels are always current, not a monthly estimate."
      highlights={[
        'Recipe costing down to the ingredient and portion',
        'Automatic stock deduction on every order',
        'Waste tracking and low-stock alerts, not a manual stock count',
      ]}
      connectsWith="Suppliers (reorder), Finance (cost of goods), Operations (what a sale consumes)."
      flow={[
        { label: 'Recipe' },
        { label: 'Ingredients', detail: 'What the dish actually consumes' },
        { label: 'Food cost', detail: 'Real margin per dish' },
        { label: 'Inventory', detail: 'Stock on hand, tracked live' },
        { label: 'Consumption', detail: 'Deducted automatically on sale' },
        { label: 'Reorder', detail: 'Suggested when stock runs low' },
      ]}
      visual={
        <PhotoWithMockup src="/images/ingredients-prep.jpg" alt="Fresh ingredients being prepped in a restaurant kitchen">
          <div className="p-3">
            <div className="flex items-center justify-between text-[10px] font-bold mb-1.5">
              Inventory
              <span className="rounded-full bg-danger/25 text-danger px-1.5 py-0.5 text-[8.5px]">3 low</span>
            </div>
            <ul className="space-y-1">
              {[
                { name: 'Chicken (kg)', qty: '2.05', status: 'low' },
                { name: 'Cooking Oil (L)', qty: '9.93', status: 'ok' },
                { name: 'Coke 500ml', qty: '40', status: 'ok' },
              ].map((r) => (
                <li key={r.name} className="flex items-center justify-between text-[10px]">
                  <span className="text-ink-muted">{r.name}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-ink-fg">{r.qty}</span>
                    <span className={`h-1.5 w-1.5 rounded-full ${r.status === 'low' ? 'bg-danger' : 'bg-ok'}`} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </PhotoWithMockup>
      }
      reverse
      tone="surface"
    />
  );
}

export function SuppliersPurchasingSection() {
  return (
    <WorkflowFeature
      id="suppliers"
      eyebrow="Suppliers & Purchasing"
      icon={Truck}
      title="From low stock to goods received, in one workflow."
      description="Supplier records, purchase requests, purchase orders and receiving live in the same system as the inventory that triggered them — no spreadsheet in between."
      highlights={[
        'Supplier records with pricing, terms and preferred status',
        'Purchase requests routed through an approval step',
        'Receiving updates inventory and supplier payables together',
      ]}
      connectsWith="Inventory (what's low), Finance (supplier payments and payables)."
      flow={[
        { label: 'Low stock detected' },
        { label: 'Reorder suggested' },
        { label: 'Purchase request' },
        { label: 'Approval' },
        { label: 'Purchase order' },
        { label: 'Goods received', detail: 'Inventory and payables update together' },
      ]}
      visual={<PhotoPanel src="/images/supplier-boxes.jpg" alt="Stacked supplier crates ready for delivery" caption="From a low-stock alert to goods on the shelf" />}
    />
  );
}

export function FinanceSection() {
  return (
    <WorkflowFeature
      id="finance"
      eyebrow="Finance & Intelligence"
      icon={Wallet}
      title="Profit you can trace back to a receipt."
      description="Revenue, expenses and supplier payments reconcile against the same orders, purchases and inventory movements the rest of the platform already recorded — not a separate bookkeeping pass."
      highlights={[
        'Revenue and expenses reconciled to real transactions',
        'Supplier payments and payables tracked against purchase orders',
        'Profit visibility, with the calculation shown, not just a number',
      ]}
      connectsWith="Operations (revenue), Inventory (cost of goods), Suppliers (payments)."
      flow={[
        { label: 'Revenue', detail: 'From Operations' },
        { label: 'Cost of goods', detail: 'From Inventory & Recipes' },
        { label: 'Expenses & supplier payments' },
        { label: 'Reconciliation' },
        { label: 'Profit visibility' },
      ]}
      reverse
      tone="surface"
    />
  );
}

export function MarketingSection() {
  return (
    <WorkflowFeature
      id="marketing"
      eyebrow="Marketing & Social"
      icon={Megaphone}
      title="Promotions that connect to what customers actually order."
      description="Run promotions and campaigns against the same order and customer data the rest of the platform already has — so you can see what a promotion actually drove, not just that it ran."
      highlights={[
        'Promotions, discounts and combos built into checkout',
        'Campaign and promotion performance, not just redemption counts',
        'Social activity as part of the same customer picture',
      ]}
      connectsWith="Operations (redemptions), Customers (engagement), Analytics (performance)."
      flow={[
        { label: 'Promotion created' },
        { label: 'Attached to menu/checkout' },
        { label: 'Customer redeems it' },
        { label: 'Order + discount recorded' },
        { label: 'Performance analyzed' },
      ]}
    />
  );
}
