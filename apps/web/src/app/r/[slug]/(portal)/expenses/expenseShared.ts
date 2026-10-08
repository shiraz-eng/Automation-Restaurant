// Shared by the Finance page, generated portals (server) and ExpensesManager
// (client) — kept out of the 'use client' module so servers can import it.

export type ExpenseStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'void';

export type Expense = {
  id: string;
  category: string;
  description: string | null;
  amount_cents: number;
  expense_date: string;
  supplier_id?: string | null;
  vendor?: string | null;
  status?: ExpenseStatus;
  payment_method?: string | null;
  payment_reference?: string | null;
  attachment_path?: string | null;
  rejection_reason?: string | null;
  void_reason?: string | null;
};

/** Columns both the Finance page and generated portals load for ExpensesManager. */
export const EXPENSE_SELECT =
  'id, category, description, amount_cents, expense_date, supplier_id, vendor, status, payment_method, payment_reference, attachment_path, rejection_reason, void_reason';

/** Only approved and paid expenses are operating costs (tenant migration 0087).
 *  A row without a status predates the workflow and was real spend. */
export const isPostedExpense = (e: Pick<Expense, 'status'>) => !e.status || e.status === 'approved' || e.status === 'paid';
