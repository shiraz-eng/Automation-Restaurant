'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChefHat, X, Send, AlertTriangle, ExternalLink, Settings, CreditCard, MessageSquare, RefreshCw } from 'lucide-react';
import {
  type GuideMsg,
  type GuideContext,
  type GuideAction,
  sendPublicGuideMessage,
  sendAuthGuideMessage,
  logGuideEvent,
  containsSecret,
  makeSessionId,
} from '@/lib/guideAi';

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = GuideMsg & {
  id: string;
  actions?: GuideAction[];
  secretWarning?: boolean;
};

type ContextualPrompt = { label: string; text: string };

function getContextualPrompts(mode: 'public' | 'portal', page?: string): ContextualPrompt[] {
  if (mode === 'public') {
    if (page?.includes('/pricing')) {
      return [
        { label: 'Compare plans', text: 'What is the difference between each plan?' },
        { label: 'Free trial', text: 'Is there a free trial?' },
        { label: 'What\'s included', text: 'What features do I get on the Starter plan?' },
        { label: 'Get started', text: 'How do I get started?' },
      ];
    }
    if (page?.includes('/get-started') || page?.includes('/onboarding')) {
      return [
        { label: 'What happens next', text: 'What happens after I sign up?' },
        { label: 'Setup time', text: 'How long does it take to set up?' },
        { label: 'What do I need', text: 'What do I need to get started?' },
      ];
    }
    return [
      { label: 'What is this?', text: 'What is Automation Restaurant?' },
      { label: 'Show pricing', text: 'What are the plans and pricing?' },
      { label: 'How it works', text: 'How does the restaurant portal system work?' },
      { label: 'Is it right for me?', text: 'Is Automation Restaurant a good fit for my restaurant?' },
    ];
  }

  // Authenticated portal prompts — contextual by page
  if (page?.includes('/menu')) {
    return [
      { label: 'Add menu items', text: 'How do I add my first menu item?' },
      { label: 'Recipes & cost', text: 'How do recipes connect to inventory?' },
      { label: 'Availability', text: 'How does menu availability work?' },
    ];
  }
  if (page?.includes('/staff')) {
    return [
      { label: 'Invite staff', text: 'How do I invite a new employee?' },
      { label: 'Portal roles', text: 'Which portal does each role use?' },
      { label: 'Permissions', text: 'How do I set up staff permissions?' },
    ];
  }
  if (page?.includes('/billing')) {
    return [
      { label: 'My plan', text: 'What plan am I on and what does it include?' },
      { label: 'Payment failed', text: 'My payment failed — what do I do?' },
      { label: 'Upgrade', text: 'How do I upgrade my plan?' },
    ];
  }
  if (page?.includes('/inventory')) {
    return [
      { label: 'How stock works', text: 'How does inventory track stock levels?' },
      { label: 'Low stock alerts', text: 'How do low stock alerts work?' },
      { label: 'Recipe deduction', text: 'How does selling a dish reduce inventory?' },
    ];
  }
  if (page?.includes('/inventory') || page?.includes('/kds') || page?.includes('/kitchen')) {
    return [
      { label: 'Kitchen setup', text: 'How do I set up my kitchen display?' },
      { label: 'Station routing', text: 'What is KDS station routing?' },
    ];
  }
  if (page?.includes('/settings')) {
    return [
      { label: 'Brand kit', text: 'How do I set up my restaurant branding?' },
      { label: 'Policies', text: 'What settings do I need to configure first?' },
    ];
  }
  if (page?.includes('/ai')) {
    return [
      { label: 'AI import', text: 'What can I import with AI?' },
      { label: 'Smart import', text: 'How does Smart Import work?' },
    ];
  }

  return [
    { label: 'Setup guide', text: 'Help me set up my restaurant.' },
    { label: 'Something broken', text: "Something isn't working — help me diagnose it." },
    { label: 'My subscription', text: 'Explain my current subscription and plan.' },
    { label: 'Why locked?', text: "Why can't I access a feature?" },
  ];
}

// ─── Action button renderer ───────────────────────────────────────────────────

function ActionButtons({ actions }: { actions: GuideAction[] }) {
  if (!actions.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map((a, i) => {
        const base = 'flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold transition-colors hover:bg-main cursor-pointer';
        if (a.type === 'billing_portal' && a.url) {
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={base}>
              <CreditCard size={11} />
              {a.label}
              <ExternalLink size={10} />
            </a>
          );
        }
        if (a.type === 'support' && a.href) {
          return (
            <a key={i} href={a.href} className={base}>
              <MessageSquare size={11} />
              {a.label}
            </a>
          );
        }
        if (a.href) {
          return (
            <a key={i} href={a.href} className={base}>
              <Settings size={11} />
              {a.label}
            </a>
          );
        }
        if (a.url) {
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={base}>
              {a.label}
              <ExternalLink size={10} />
            </a>
          );
        }
        return null;
      })}
    </div>
  );
}

// ─── Main panel component ─────────────────────────────────────────────────────

export interface GuideAiPanelProps {
  mode: 'public' | 'portal';
  slug?: string;
  page?: string;
  restaurantName?: string;
  planTier?: string;
  subscriptionStatus?: string;
  getToken?: () => Promise<string | null>;
  onClose?: () => void;
  embedded?: boolean; // true → no fixed positioning (renders in page flow)
}

export function GuideAiPanel({
  mode,
  slug,
  page,
  restaurantName,
  planTier,
  subscriptionStatus,
  getToken,
  onClose,
  embedded = false,
}: GuideAiPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretWarning, setSecretWarning] = useState(false);
  const [pendingText, setPendingText] = useState('');
  const sessionId = useRef(makeSessionId());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const prompts = getContextualPrompts(mode, page);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      // Secret detection
      if (containsSecret(trimmed)) {
        setSecretWarning(true);
        setPendingText(trimmed);
        logGuideEvent('secret_warning_shown', sessionId.current, { page }, slug);
        return;
      }

      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: trimmed };
      const nextMessages = [...messages, userMsg];
      setMessages(nextMessages);
      setInput('');
      setBusy(true);
      setError(null);
      logGuideEvent('message_sent', sessionId.current, { page, mode }, slug);

      const context: GuideContext = { mode, page, slug };
      const apiMessages = nextMessages.map(({ role, content }) => ({ role, content }));

      try {
        let response;
        if (mode === 'portal' && getToken) {
          const token = await getToken();
          if (!token) throw new Error('Session expired — please refresh and try again.');
          response = await sendAuthGuideMessage(apiMessages, context, token);
        } else {
          response = await sendPublicGuideMessage(apiMessages, context);
        }
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.reply,
          actions: response.actions,
        };
        setMessages((m) => [...m, assistantMsg]);
      } catch (err) {
        setError((err as Error).message ?? 'The guide is unavailable right now.');
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, mode, page, slug, getToken],
  );

  function dismissSecretWarning(proceed: boolean) {
    setSecretWarning(false);
    if (proceed) {
      // User explicitly chose to proceed — send without scanning again
      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: pendingText };
      setMessages((m) => [...m, userMsg]);
      setInput('');
      setPendingText('');
      // We do NOT actually send a request — user should be rotating the secret, not sending it.
      setError('Please rotate any secrets you may have shared through the appropriate dashboard, then try again with a description of your problem instead.');
    }
    setPendingText('');
  }

  const containerClass = embedded
    ? 'flex flex-col bg-surface rounded-lg border border-border overflow-hidden h-[520px]'
    : 'flex flex-col bg-surface rounded-xl border border-border overflow-hidden shadow-2xl';

  return (
    <div className={containerClass}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border bg-ink text-ink-fg shrink-0">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-gold text-ink shrink-0">
          <ChefHat size={15} strokeWidth={2.4} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-bold leading-tight truncate">Automation Restaurant AI Guide</div>
          <div className="text-[10px] text-ink-muted leading-tight">Your Automation Restaurant guide</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded hover:bg-white/10 transition-colors text-ink-muted hover:text-ink-fg"
            aria-label="Close guide"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Auth context banner */}
      {mode === 'portal' && restaurantName && (
        <div className="flex items-center gap-2 px-4 py-2 bg-main border-b border-border text-[11px] shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-ok shrink-0" />
          <span className="font-semibold text-body truncate">{restaurantName}</span>
          {planTier && (
            <span className="ml-auto shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 font-semibold capitalize">
              {planTier}
            </span>
          )}
          {subscriptionStatus && (
            <span className={`shrink-0 rounded-full px-2 py-0.5 font-semibold capitalize text-[10px]
              ${subscriptionStatus === 'active' || subscriptionStatus === 'trialing' ? 'bg-ok/10 text-ok border border-ok/30' : 'bg-danger/10 text-danger border border-danger/30'}`}>
              {subscriptionStatus}
            </span>
          )}
        </div>
      )}

      {/* Secret warning overlay */}
      {secretWarning && (
        <div className="absolute inset-x-0 z-10 mx-4 mt-24 rounded-lg border border-danger/40 bg-danger/10 p-4 shadow-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
            <div>
              <div className="text-xs font-bold text-danger mb-1">⚠ Possible secret detected</div>
              <p className="text-xs text-body mb-3">
                Your message appears to contain a secret key (API key, JWT, or password). Never share secrets in chat — they should only be entered in the appropriate dashboard.
              </p>
              <p className="text-xs text-muted mb-3">
                If you accidentally exposed a key, rotate it immediately in the Supabase or Stripe dashboard.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => dismissSecretWarning(false)}
                  className="rounded px-3 py-1.5 text-xs font-semibold bg-primary text-primary-fg"
                >
                  Got it — I'll rotate it
                </button>
                <button
                  onClick={() => dismissSecretWarning(true)}
                  className="rounded px-3 py-1.5 text-xs font-semibold border border-border hover:bg-main"
                >
                  Send anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 relative">
        {messages.length === 0 && (
          <div className="text-center py-6">
            <div className="text-[11px] text-muted mb-4">How can I help you today?</div>
            <div className="grid gap-1.5">
              {prompts.map((p) => (
                <button
                  key={p.text}
                  onClick={() => { logGuideEvent('prompt_selected', sessionId.current, { prompt: p.label, page }, slug); send(p.text); }}
                  disabled={busy}
                  className="w-full text-left rounded-lg border border-border px-3 py-2 text-[11px] hover:border-gold/50 hover:bg-main transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed
              ${m.role === 'user'
                ? 'bg-ink text-ink-fg'
                : 'bg-main border border-border text-body'}`}
            >
              {m.role === 'assistant' ? (
                <div className="whitespace-pre-wrap">{m.content}</div>
              ) : (
                m.content
              )}
              {m.actions && <ActionButtons actions={m.actions} />}
            </div>
          </div>
        ))}

        {busy && (
          <div className="flex justify-start">
            <div className="rounded-xl px-3 py-2 text-xs bg-main border border-border text-muted flex items-center gap-2">
              <RefreshCw size={12} className="animate-spin" />
              Thinking…
            </div>
          </div>
        )}

        {error && (
          <div className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2 border border-danger/30">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3 shrink-0">
        {messages.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {prompts.slice(0, 2).map((p) => (
              <button
                key={p.text}
                onClick={() => { logGuideEvent('prompt_selected', sessionId.current, { prompt: p.label, page }, slug); send(p.text); }}
                disabled={busy}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] hover:border-gold/40 transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && input.trim()) { e.preventDefault(); send(input); } }}
            placeholder="Ask anything about Automation Restaurant…"
            disabled={busy}
            className="flex-1 rounded-lg border border-border bg-main px-3 py-1.5 text-xs outline-none focus:border-gold/50 disabled:opacity-60 placeholder:text-muted"
          />
          <button
            onClick={() => send(input)}
            disabled={busy || !input.trim()}
            className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-ink-fg hover:opacity-80 disabled:opacity-40 transition-opacity shrink-0"
            aria-label="Send"
          >
            <Send size={13} />
          </button>
        </div>
        <div className="text-[9px] text-muted mt-1.5 text-center">
          AI Guide · For product help only · Never share secrets
        </div>
      </div>
    </div>
  );
}
