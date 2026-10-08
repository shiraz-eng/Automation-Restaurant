-- ============================================================================
-- 0088_expense_read_for_approvers.sql — follow-up to 0087
-- A portal granted only "Approve expenses" or "Mark expenses paid" must be
-- able to see the expenses it acts on (and the person who records them must
-- see their own list). Read access only; writes are unchanged.
-- ============================================================================
drop policy if exists staff_read on public.expenses;
create policy staff_read on public.expenses for select using (
  app.has_perm('finance.view') or app.has_perm('finance.create_expense') or app.has_perm('finance.update_expense')
  or app.has_perm('finance.approve_expense') or app.has_perm('finance.pay_expense'));
