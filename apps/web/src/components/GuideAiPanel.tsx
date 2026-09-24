'use client';

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import {
  ChefHat,
  X,
  Send,
  AlertTriangle,
  ExternalLink,
  Settings,
  CreditCard,
  MessageSquare,
  RotateCcw,
  Square,
  Sparkles,
  Rocket,
  Database,
  Wrench,
  BadgeDollarSign,
  ShieldCheck,
  ListChecks,
} from 'lucide-react';
import {
  type GuideMsg,
  type GuideAction,
  logGuideEvent,
  containsSecret,
  makeSessionId,
  splitSuggestions,
  streamGuideMessage,
} from '@/lib/guideAi';

// ─── Types ────────────────────────────────────────────────────────────────────

type Message = GuideMsg & {
  id: string;
  actions?: GuideAction[];
  suggestions?: string[];
  streaming?: boolean;
};

type Prompt = { label: string; text: string };
type PromptGroup = { title: string; icon: ReactNode; prompts: Prompt[] };

// ─── Recommendations ──────────────────────────────────────────────────────────
// Written from a new owner's point of view: the questions people actually
// have before buying, while connecting Supabase, and in their first week.

function publicGroups(page?: string): PromptGroup[] {
  const onPricing = page?.includes('/pricing');
  const onSetup = page?.includes('/get-started') || page?.includes('/onboarding');
  const value: PromptGroup = {
    title: 'See if it fits',
    icon: <Sparkles size={12} />,
    prompts: [
      { label: 'What will it do for my restaurant?', text: 'What will Automation Restaurant actually do for my restaurant day to day?' },
      { label: 'How does food availability run itself?', text: 'How does automatic food availability work, and why does it matter?' },
      { label: 'Can my staff each get their own login?', text: 'Can each station or staff member get their own login with limited access?' },
    ],
  };
  const setup: PromptGroup = {
    title: 'Setup & Supabase',
    icon: <Database size={12} />,
    prompts: [
      { label: 'Walk me through setup step by step', text: 'Walk me through the whole setup step by step. How long does it take?' },
      { label: 'Why do I need a Supabase account?', text: 'What is Supabase, why do I connect my own account, and is it free?' },
      { label: 'What do I need before I start?', text: 'What should I have ready before I sign up?' },
    ],
  };
  const plans: PromptGroup = {
    title: 'Plans & trust',
    icon: <BadgeDollarSign size={12} />,
    prompts: [
      { label: 'Which plan fits my restaurant?', text: 'Which plan fits a restaurant like mine? Compare the plans.' },
      { label: 'Is my data safe and mine?', text: 'Is my data safe, and who owns it?' },
      { label: 'What does it cost in total?', text: 'What will it cost in total, including the database?' },
    ],
  };
  if (onSetup) return [setup, { ...value, prompts: value.prompts.slice(0, 2) }, plans];
  if (onPricing) return [plans, setup, value];
  return [value, setup, plans];
}

const PAGE_PROMPTS: [RegExp, Prompt[]][] = [
  [/\/menu\/priority/, [
    { label: 'How do the percentages work?', text: 'How do the Critical/High/Medium/Low percentages decide availability?' },
    { label: 'Why is a dish showing 0?', text: 'Why would a dish show 0 available when I have stock?' },
  ]],
  [/\/menu/, [
    { label: 'Import my menu from a photo', text: 'How do I import my whole menu from a photo or PDF?' },
    { label: 'Add sizes and add-ons', text: 'How do I add sizes (variants) and add-ons to a dish?' },
  ]],
  [/\/portals/, [
    { label: 'Create a counter login', text: 'How do I create a login for my counter with only the access it needs?' },
    { label: 'Test a portal safely', text: 'How do I test a portal without logging myself out?' },
  ]],
  [/\/deals/, [
    { label: 'Build a combo deal', text: 'How do I create a combo deal with a schedule?' },
    { label: 'Deal not on the menu?', text: 'Why is my deal not showing on the customer menu?' },
  ]],
  [/\/kds|\/kitchen/, [
    { label: 'How the food board works', text: 'How does the Food availability board in the kitchen work?' },
    { label: 'Record wasted food', text: 'How do I record wasted dishes so stock stays right?' },
  ]],
  [/\/inventory/, [
    { label: 'Stock goes down by itself?', text: 'How does selling a dish reduce ingredient stock?' },
    { label: 'Low-stock alerts', text: 'How do low-stock alerts and reordering work?' },
  ]],
  [/\/recipes/, [
    { label: 'Link dishes to ingredients', text: 'How do I link a dish to its ingredients and see its food cost?' },
    { label: 'Why recipes matter', text: 'What do recipes switch on in the rest of the system?' },
  ]],
  [/\/staff|\/scheduling/, [
    { label: 'Add a team member', text: 'How do I add a staff member and give them a login?' },
    { label: 'Roles vs portals', text: 'What is the difference between staff roles and portals?' },
  ]],
  [/\/checkout|\/register/, [
    { label: 'Take a payment', text: 'How do I take a payment and print the receipt?' },
    { label: 'Refunds and discounts', text: 'How do refunds and discounts work at checkout?' },
  ]],
  [/\/settings/, [
    { label: 'Set up my branding', text: 'How do I set my logo, colours and receipt details?' },
  ]],
  [/\/tables/, [
    { label: 'Print table QR codes', text: 'How do I print QR codes for my tables and test them?' },
  ]],
];

function portalGroups(page?: string): PromptGroup[] {
  const here = PAGE_PROMPTS.find(([re]) => page && re.test(page))?.[1];
  return [
    ...(here ? [{ title: 'On this page', icon: <Sparkles size={12} />, prompts: here }] : []),
    {
      title: 'Set up my restaurant',
      icon: <ListChecks size={12} />,
      prompts: [
        { label: 'What should I set up first?', text: 'I just got my portal. What should I set up first, in order?' },
        { label: 'Get ready for my first order', text: 'Help me get everything ready for my first real order.' },
        ...(here ? [] : [{ label: 'Create logins for my stations', text: 'How do I create logins for my counter and kitchen?' }]),
      ],
    },
    {
      title: 'Fix a problem',
      icon: <Wrench size={12} />,
      prompts: [
        { label: 'A dish shows 0 or Unavailable', text: 'A dish shows 0 or Unavailable — how do I fix it?' },
        { label: "I get a permission error", text: "I get a \"doesn't have permission\" error. What's wrong?" },
        { label: 'Restaurant not loading', text: "My restaurant pages aren't loading or show errors. What should I check?" },
      ],
    },
  ];
}

// ─── Minimal, safe Markdown rendering (bold, code, lists, headings, links) ────

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`'))
      out.push(
        <code key={`${key}-${i++}`} className="rounded bg-surface px-1 py-px text-[11px] font-mono">
          {tok.slice(1, -1)}
        </code>,
      );
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const href = lm?.[2] ?? '#';
      const safe = href.startsWith('/') || href.startsWith('https://');
      out.push(
        safe ? (
          <a
            key={`${key}-${i++}`}
            href={href}
            className="font-semibold text-primary underline underline-offset-2"
            {...(href.startsWith('https://') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {lm?.[1]}
          </a>
        ) : (
          lm?.[1]
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={`l${blocks.length}`}
        className={`${list.ordered ? 'list-decimal' : 'list-disc'} pl-4 space-y-0.5 marker:text-muted`}
      >
        {list.items.map((it, j) => (
          <li key={j}>{inline(it, `li${blocks.length}-${j}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (ol || ul) {
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flush();
      if (!list) list = { ordered, items: [] };
      list.items.push((ol ?? ul)![1]);
      return;
    }
    flush();
    if (!line.trim()) return;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={`h${idx}`} className="font-bold text-[12px] pt-1">
          {inline(h[1], `h${idx}`)}
        </div>,
      );
      return;
    }
    blocks.push(<p key={`p${idx}`}>{inline(line, `p${idx}`)}</p>);
  });
  flush();
  return <div className="space-y-1.5">{blocks}</div>;
}

// ─── Action buttons ───────────────────────────────────────────────────────────

function ActionButtons({ actions }: { actions: GuideAction[] }) {
  if (!actions.length) return null;
  const base =
    'inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold transition-colors hover:border-gold/60';
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {actions.map((a, i) => {
        if (a.type === 'billing_portal' && a.url)
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={base}>
              <CreditCard size={11} /> {a.label} <ExternalLink size={10} />
            </a>
          );
        if (a.type === 'support' && a.href)
          return (
            <a key={i} href={a.href} className={base}>
              <MessageSquare size={11} /> {a.label}
            </a>
          );
        if (a.href)
          return (
            <a key={i} href={a.href} className={base}>
              <Settings size={11} /> {a.label}
            </a>
          );
        if (a.url)
          return (
            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={base}>
              {a.label} <ExternalLink size={10} />
            </a>
          );
        return null;
      })}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export interface GuideAiPanelProps {
  mode: 'public' | 'portal';
  slug?: string;
  page?: string;
  restaurantName?: string;
  planTier?: string;
  subscriptionStatus?: string;
  /** Kept for API compatibility; the guide no longer needs a session token. */
  getToken?: () => Promise<string | null>;
  onClose?: () => void;
  embedded?: boolean; // true → renders in page flow
}

export function GuideAiPanel({
  mode,
  slug,
  page,
  restaurantName,
  planTier,
  subscriptionStatus,
  onClose,
  embedded = false,
}: GuideAiPanelProps) {
  const storageKey = `guide_chat_${mode}_${slug ?? 'site'}`;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretWarning, setSecretWarning] = useState(false);
  const sessionId = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the conversation while moving between pages (this browser tab only).
  useEffect(() => {
    sessionId.current = makeSessionId();
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) setMessages((JSON.parse(saved) as Message[]).map((m) => ({ ...m, streaming: false })));
    } catch {
      /* storage unavailable */
    }
  }, [storageKey]);
  useEffect(() => {
    if (busy) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-30)));
    } catch {
      /* storage unavailable */
    }
  }, [messages, busy, storageKey]);

  useEffect(() => {
    // Only follow the conversation; the welcome screen starts at the top.
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth', block: 'end' });
  }, [messages, busy]);

  const groups = mode === 'public' ? publicGroups(page) : portalGroups(page);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      if (containsSecret(trimmed)) {
        setSecretWarning(true);
        logGuideEvent('secret_warning_shown', sessionId.current, { page }, slug);
        return;
      }
      const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: trimmed };
      const assistantId = crypto.randomUUID();
      const history = [...messages, userMsg];
      setMessages([...history, { id: assistantId, role: 'assistant', content: '', streaming: true }]);
      setInput('');
      setBusy(true);
      setError(null);
      logGuideEvent('message_sent', sessionId.current, { page, mode }, slug);

      const controller = new AbortController();
      abortRef.current = controller;
      const update = (patch: Partial<Message>) =>
        setMessages((ms) => ms.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)));

      try {
        const { actions, text: full } = await streamGuideMessage(
          history.map(({ role, content }) => ({ role, content })),
          { mode, page, slug, restaurantName, planTier, subscriptionStatus },
          (soFar) => update({ content: splitSuggestions(soFar).body }),
          controller.signal,
        );
        const { body, suggestions } = splitSuggestions(full);
        update({
          content: body || "Sorry — I couldn't put an answer together. Try asking another way.",
          suggestions,
          actions,
          streaming: false,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setMessages((ms) =>
            ms.map((m) => (m.id === assistantId ? { ...m, streaming: false, content: m.content || '(stopped)' } : m)),
          );
        } else {
          setMessages((ms) => ms.filter((m) => m.id !== assistantId));
          setError((err as Error).message || 'The guide is unavailable right now. Please try again.');
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    },
    [busy, messages, mode, page, slug, restaurantName, planTier, subscriptionStatus],
  );

  const pick = (p: Prompt) => {
    logGuideEvent('prompt_selected', sessionId.current, { prompt: p.label, page }, slug);
    void send(p.text);
  };

  function clearChat() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const containerClass = embedded
    ? 'relative flex flex-col bg-surface rounded-lg border border-border overflow-hidden h-[560px]'
    : 'relative flex flex-col bg-surface overflow-hidden h-full';

  return (
    <div className={containerClass}>
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-ink text-ink-fg shrink-0">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-gold text-ink shrink-0">
          <ChefHat size={16} strokeWidth={2.4} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-bold leading-tight truncate">AI Guide</div>
          <div className="text-[10px] text-ink-muted leading-tight truncate">
            {mode === 'portal' ? 'Setup help & answers for your portal' : 'Setup, Supabase & plans — answered in seconds'}
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="grid h-7 w-7 place-items-center rounded-lg text-ink-muted hover:text-ink-fg hover:bg-white/10"
            aria-label="Start a new conversation"
            title="New conversation"
          >
            <RotateCcw size={13} />
          </button>
        )}
        {onClose && (
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-ink-muted hover:text-ink-fg hover:bg-white/10"
            aria-label="Close guide"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {mode === 'portal' && restaurantName && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-main border-b border-border text-[11px] shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-ok shrink-0" />
          <span className="font-semibold text-body truncate">{restaurantName}</span>
          {planTier && (
            <span className="ml-auto shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 font-semibold capitalize">
              {planTier}
            </span>
          )}
          {subscriptionStatus && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 font-semibold capitalize text-[10px] ${
                subscriptionStatus === 'active' || subscriptionStatus === 'trialing'
                  ? 'bg-ok/10 text-ok border border-ok/30'
                  : 'bg-danger/10 text-danger border border-danger/30'
              }`}
            >
              {subscriptionStatus}
            </span>
          )}
        </div>
      )}

      {/* Secret warning */}
      {secretWarning && (
        <div className="absolute inset-x-3 top-16 z-10 rounded-lg border border-danger/40 bg-surface p-4 shadow-lg">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-danger mt-0.5 shrink-0" />
            <div>
              <div className="text-xs font-bold text-danger mb-1">That looks like a secret key</div>
              <p className="text-xs text-body mb-2">
                Never paste API keys, tokens or passwords into chat — I don&rsquo;t need them to help you. Your message
                wasn&rsquo;t sent.
              </p>
              <p className="text-xs text-muted mb-3">
                If it was a real key, rotate it now in the dashboard it came from (Supabase, Stripe…), then describe
                the problem in words.
              </p>
              <button
                onClick={() => setSecretWarning(false)}
                className="rounded px-3 py-1.5 text-xs font-semibold bg-primary text-primary-fg"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-3">
            <div className="rounded-xl bg-main border border-border p-3">
              <div className="text-[13px] font-bold">
                {mode === 'portal' ? `Hi${restaurantName ? `, ${restaurantName} team` : ''} 👋` : 'Hi, I’m your setup guide 👋'}
              </div>
              <p className="text-[11px] text-muted mt-0.5 leading-snug">
                {mode === 'portal'
                  ? 'Ask me how to set anything up, or tell me what’s not working — I’ll point you to the exact screen.'
                  : 'I’ll explain what you get, how setup and Supabase work, and help you pick a plan. No sign-up needed.'}
              </p>
              <div className="mt-2 flex items-center gap-1 text-[10px] text-muted">
                <ShieldCheck size={11} className="text-ok" /> I never need your passwords or keys.
              </div>
            </div>
            {groups.map((g) => (
              <div key={g.title}>
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted mb-1.5">
                  <span className="text-gold">{g.icon}</span>
                  {g.title}
                </div>
                <div className="grid gap-1.5">
                  {g.prompts.map((p) => (
                    <button
                      key={p.text}
                      onClick={() => pick(p)}
                      disabled={busy}
                      className="w-full text-left rounded-lg border border-border bg-surface px-3 py-2 text-[12px] hover:border-gold/60 hover:bg-main transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {mode === 'public' && (
              <a
                href="/get-started"
                className="flex items-center justify-center gap-1.5 rounded-lg bg-gold text-ink px-3 py-2 text-[12px] font-bold hover:opacity-90"
              >
                <Rocket size={13} /> Start setup — about 15 minutes
              </a>
            )}
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[88%] rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed ${
                m.role === 'user' ? 'bg-ink text-ink-fg rounded-br-md' : 'bg-main border border-border text-body rounded-bl-md'
              }`}
            >
              {m.role === 'assistant' ? (
                m.content ? (
                  <>
                    <RichText text={m.content} />
                    {m.streaming && <span className="inline-block w-1.5 h-3.5 align-middle bg-muted/60 animate-pulse ml-0.5" />}
                  </>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted" aria-label="Thinking">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce [animation-delay:-0.2s]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce [animation-delay:-0.1s]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" />
                  </span>
                )
              ) : (
                <span className="whitespace-pre-wrap">{m.content}</span>
              )}
              {m.actions && !m.streaming && <ActionButtons actions={m.actions} />}
            </div>
          </div>
        ))}

        {!busy && lastAssistant?.suggestions && lastAssistant.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-1">
            {lastAssistant.suggestions.map((s) => (
              <button
                key={s}
                onClick={() => pick({ label: s, text: s })}
                className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[11px] font-semibold text-body hover:bg-gold/20 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2 border border-danger/30">{error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3 shrink-0 bg-surface">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-main px-2.5 py-1.5 focus-within:border-gold/60">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && input.trim()) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder={mode === 'portal' ? 'Ask how to set something up…' : 'Ask about setup, Supabase, plans…'}
            disabled={busy}
            className="flex-1 resize-none bg-transparent py-1 text-[12.5px] outline-none disabled:opacity-60 placeholder:text-muted max-h-24"
          />
          {busy ? (
            <button
              onClick={() => abortRef.current?.abort()}
              className="grid h-8 w-8 place-items-center rounded-lg border border-border text-body hover:bg-surface shrink-0"
              aria-label="Stop answering"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              onClick={() => void send(input)}
              disabled={!input.trim()}
              className="grid h-8 w-8 place-items-center rounded-lg bg-ink text-ink-fg hover:opacity-85 disabled:opacity-35 transition-opacity shrink-0"
              aria-label="Send"
            >
              <Send size={13} />
            </button>
          )}
        </div>
        <div className="text-[9.5px] text-muted mt-1.5 text-center">
          AI can make mistakes — check anything important. Never share passwords or keys.
        </div>
      </div>
    </div>
  );
}

