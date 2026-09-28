-- ============================================================================
-- 0081 — saved AI chats
--
-- Every conversation with the staff AI Assistant and with the customer
-- ordering assistant is stored, so staff can reopen earlier chats (like
-- ChatGPT's history) and the owner can read what guests asked.
--
--   ai_conversations  one chat. kind 'staff' belongs to user_id (the login
--                     that had it); kind 'customer' is keyed by guest_session
--                     (a random id the guest's browser keeps).
--   ai_messages       its messages in order; `extras` keeps what the chat
--                     showed with a reply (tools used, cards, a PDF document,
--                     a proposed action) and `attachment` a user's file.
--
-- Only the API writes (service role). Staff read and delete their OWN staff
-- chats; customer chats are readable by staff who may view customers.
-- ============================================================================

create table if not exists public.ai_conversations (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('staff', 'customer')),
  user_id       uuid,
  guest_session text,
  title         text not null default 'New chat',
  message_count int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((kind = 'staff' and user_id is not null) or (kind = 'customer' and guest_session is not null))
);
create index if not exists ai_conversations_user_idx on public.ai_conversations (user_id, updated_at desc) where kind = 'staff';
create index if not exists ai_conversations_customer_idx on public.ai_conversations (updated_at desc) where kind = 'customer';
create index if not exists ai_conversations_guest_idx on public.ai_conversations (guest_session) where kind = 'customer';

create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  attachment      jsonb,
  extras          jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);

alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;

drop policy if exists own_staff_chats_read on public.ai_conversations;
create policy own_staff_chats_read on public.ai_conversations for select
  using (kind = 'staff' and user_id = auth.uid() and app.has_perm('ai.view'));
drop policy if exists own_staff_chats_delete on public.ai_conversations;
create policy own_staff_chats_delete on public.ai_conversations for delete
  using (kind = 'staff' and user_id = auth.uid() and app.has_perm('ai.view'));
drop policy if exists customer_chats_read on public.ai_conversations;
create policy customer_chats_read on public.ai_conversations for select
  using (kind = 'customer' and app.has_perm('customers.view'));

drop policy if exists chat_messages_read on public.ai_messages;
create policy chat_messages_read on public.ai_messages for select
  using (exists (select 1 from public.ai_conversations c where c.id = conversation_id));
-- (the subquery runs with the caller's rights, so it only sees conversations
--  the policies above already allow them to read)
