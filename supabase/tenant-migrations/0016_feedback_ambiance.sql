-- 0016: add an "ambiance" category to customer feedback, alongside the
-- existing food/service/cleanliness/speed. Idempotent.
alter table public.feedback
  add column if not exists ambiance int check (ambiance between 1 and 5);
