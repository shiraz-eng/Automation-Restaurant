import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Saved AI chats (tenant-migrations/0081): ai_conversations + ai_messages.
 * Used by the staff AI Assistant (routes/ai.ts) and the customer ordering
 * assistant (routes/customerAi.ts). Written with the service role only.
 *
 * Saving is best-effort: if it fails (e.g. a restaurant whose database
 * hasn't received 0081 yet) the chat itself still works — it just isn't
 * stored — so every function here reports failure instead of throwing.
 */

type Owner = { kind: 'staff'; userId: string } | { kind: 'customer'; guestSession: string };

const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || 'New chat';
};

/** The conversation to save into: the given one if it belongs to this owner, else a new one. */
export async function openConversation(
  admin: SupabaseClient,
  owner: Owner,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<string | null> {
  try {
    if (conversationId) {
      let q = admin.from('ai_conversations').select('id').eq('id', conversationId).eq('kind', owner.kind);
      q = owner.kind === 'staff' ? q.eq('user_id', owner.userId) : q.eq('guest_session', owner.guestSession);
      const { data } = await q.maybeSingle();
      if (data?.id) return data.id as string;
    }
    const { data, error } = await admin
      .from('ai_conversations')
      .insert({
        kind: owner.kind,
        user_id: owner.kind === 'staff' ? owner.userId : null,
        guest_session: owner.kind === 'customer' ? owner.guestSession : null,
        title: titleFrom(firstMessage),
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id as string;
  } catch (err) {
    console.warn('[ai-chat-store] could not open a conversation (not migrated yet?):', (err as Error).message ?? err);
    return null;
  }
}

/** Stores one question and its answer, and bumps the conversation's time and count. */
export async function saveExchange(
  admin: SupabaseClient,
  conversationId: string | null,
  user: { content: string; attachment?: unknown },
  assistant: { content: string; extras?: Record<string, unknown> },
): Promise<void> {
  if (!conversationId) return;
  try {
    const now = Date.now();
    const { error } = await admin.from('ai_messages').insert([
      { conversation_id: conversationId, role: 'user', content: user.content, attachment: user.attachment ?? null, created_at: new Date(now).toISOString() },
      {
        conversation_id: conversationId,
        role: 'assistant',
        content: assistant.content || '(no answer)',
        extras: assistant.extras && Object.keys(assistant.extras).length ? assistant.extras : null,
        created_at: new Date(now + 1).toISOString(),
      },
    ]);
    if (error) throw error;
    const { count } = await admin.from('ai_messages').select('id', { count: 'exact', head: true }).eq('conversation_id', conversationId);
    await admin
      .from('ai_conversations')
      .update({ updated_at: new Date().toISOString(), message_count: count ?? 0 })
      .eq('id', conversationId);
  } catch (err) {
    console.warn('[ai-chat-store] could not save the exchange:', (err as Error).message ?? err);
  }
}

/** Only fields that are actually set, so saved rows stay small. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)));
}
