-- ============================================================================
-- 0108 — AI settings per module.
--
-- One restaurant-wide default (module = 'global') plus an optional override
-- for each portal module (pos, kitchen, inventory, finance, …): the languages
-- the assistant listens for and answers in, whether language is detected
-- automatically, and whether voice input and spoken answers are offered. A NULL column inherits from 'global', and
-- 'global' from the built-in defaults (packages/shared/src/aiConfig.ts).
--
-- Only the API writes here, with the service role, after checking
-- settings.update — so no client policies are granted. These settings never
-- widen access: the assistant still sees and does only what the signed-in
-- person's own permissions allow.
-- ============================================================================

create table if not exists public.ai_module_settings (
  module            text primary key check (module ~ '^[a-z_]{2,32}$'),
  input_language    text check (input_language ~ '^(auto|[a-z]{2}(-[A-Za-z]{2,4})?)$'),
  response_language text check (response_language ~ '^(auto|[a-z]{2}(-[A-Za-z]{2,4})?)$'),
  auto_detect       boolean,
  voice_input       boolean,
  voice_output      boolean,
  voice_name        text check (char_length(voice_name) <= 120),
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

alter table public.ai_module_settings enable row level security;
revoke all on table public.ai_module_settings from anon, authenticated;
grant all on table public.ai_module_settings to service_role;
