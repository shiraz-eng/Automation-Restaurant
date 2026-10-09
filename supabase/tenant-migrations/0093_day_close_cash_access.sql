-- ============================================================================
-- 0093_day_close_cash_access.sql — follow-up to 0092
-- A portal granted only "Record cash drawer pay-ins, pay-outs and bank drops"
-- (cash.manage) needs the day's expected cash and the closing history to do
-- that job, so it may read the close preview and daily closings too.
-- ============================================================================
do $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.day_close_preview(date, integer)'::regprocedure);
  v_new := replace(v_def,
    'if not (app.has_perm(''finance.close_day'') or app.has_perm(''finance.view'') or app.has_perm(''finance.reconcile'')) then',
    'if not (app.has_perm(''finance.close_day'') or app.has_perm(''finance.view'') or app.has_perm(''finance.reconcile'') or app.has_perm(''cash.manage'')) then');
  if v_new = v_def then
    if position('app.has_perm(''cash.manage'')' in v_def) = 0 then
      raise exception 'day_close_preview permission check not found — patch it by hand';
    end if;
  else
    execute v_new;
  end if;
end $$;

drop policy if exists staff_read on public.daily_closings;
create policy staff_read on public.daily_closings for select using (
  app.has_perm('finance.view') or app.has_perm('finance.close_day') or app.has_perm('finance.reopen_day')
  or app.has_perm('finance.reconcile') or app.has_perm('cash.manage') or app.can_write());
