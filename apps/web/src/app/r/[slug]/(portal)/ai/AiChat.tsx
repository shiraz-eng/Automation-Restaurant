'use client';

import { useEffect, useRef, useState } from 'react';
import { usePortalSupabase } from '@/components/PortalProvider';
import { formatCents } from '@/lib/format';
import { Markdown } from '@/components/Markdown';
import { streamAiChat } from '@/lib/aiStream';
import { downloadTextPdf } from '@/lib/textToPdf';
import { ProfitDrilldownModal, OrderDrilldownModal, DealDrilldownModal, type OrderProfitRow, type DealProfitRow } from '@/components/ProfitDrilldown';
import { aiLanguage, detectLanguage, isRtlLanguage, type AiModuleKey } from '@automation-restaurant/shared';
import { useAiVoice } from '@/lib/ai/useAiVoice';
import { speak, stopSpeech, useSpeechInput } from '@/lib/ai/speech';
import { AiVoiceSettings, MicButton, SpeakControls, VoiceStatus } from '@/components/ai/VoiceControls';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type PendingAction = { id: string; name: string; args: Record<string, unknown>; summary: string };
type Resolution = 'confirmed' | 'cancelled' | 'failed';
// The exact period_profitability() row get_period_profitability returned
// to the model, captured verbatim server-side (routes/ai.ts) — never a
// second client-side fetch, so this card can never say something
// different from what the assistant's own reply just said.
type ProfitCard = {
  period: string;
  from_ts: string;
  to_ts: string;
  gross_sales_cents: number;
  discount_cents: number;
  refunded_cents: number;
  net_sales_cents: number;
  theoretical_cogs_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number | null;
  expenses_cents: number;
  net_profit_cents: number;
  net_profit_margin_pct: number | null;
};
type Msg = {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
  pendingAction?: PendingAction;
  resolution?: Resolution;
  resolutionMessage?: string;
  profitCard?: ProfitCard;
  orderCard?: OrderProfitRow;
  dealCard?: { period: string; deals: DealProfitRow[] };
  /** The file attached to this (user) message, stored in the 'ai-chat' bucket. */
  attachment?: FileRef;
  /** A PDF the assistant wrote on request (create_pdf_document). */
  document?: { title: string; content: string };
  /** Reopened from a saved chat — its proposal buttons are not live any more. */
  fromHistory?: boolean;
  /** The language the answer was written in (the API says), for direction and read-aloud. */
  language?: string;
};
type SavedChat = { id: string; title: string; updated_at: string; message_count: number };
type FileRef = { name: string; mimeType: string; storagePath: string };

// Mirrors routes/ai.ts's FILE_MIME_TYPES and MAX_FILE_BYTES (and the
// 'ai-chat' bucket's own limits, tenant-migrations/0080) — checked here too
// so a rejection is instant rather than a round trip.
const ACCEPTED_ATTACHMENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/csv', 'text/plain',
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
type PendingFile = { file: File; name: string; mimeType: string };

/** A PDF title for an answer: the question that prompted it, shortened. */
function pdfTitleFor(msgs: Msg[], index: number): string {
  for (let j = index - 1; j >= 0; j--) {
    const m = msgs[j]!;
    if (m.role === 'user') {
      const q = m.content.replace(/\s+/g, ' ').trim();
      return q.length > 70 ? `${q.slice(0, 67)}…` : q || 'AI Assistant answer';
    }
  }
  return 'AI Assistant answer';
}

const SUGGESTIONS = [
  'How is my restaurant doing right now?',
  'What needs my attention?',
  'How are sales this month vs last month?',
  'What are our best-selling items this week?',
  'Give me 5 ideas to increase weekday sales',
  'Write a WhatsApp message announcing our new deal',
  'Make a PDF kitchen hygiene checklist',
];

// Opened from a module (the AI Guide's data tab), the first suggestions are about that module.
const MODULE_SUGGESTIONS: Partial<Record<AiModuleKey, string[]>> = {
  pos: ['What were today’s sales so far?', 'Show me the latest orders', 'Any reservations tonight?'],
  kitchen: ['What is happening in the kitchen right now?', 'Which dishes are unavailable right now?', 'How fast is the kitchen today?'],
  menu: ['Which dishes sold best this week?', 'Which dishes should I promote or drop?', 'How are my deals performing?'],
  marketing: ['How are my promotions performing this month?', 'What are guests saying in recent feedback?', 'Draft a post announcing tonight’s special'],
  inventory: ['Which ingredients are low on stock?', 'What is my food cost this month?', 'How much did we waste this week?'],
  suppliers: ['What do I owe suppliers right now?', 'How are my suppliers performing?', 'Summarise purchasing this month'],
  finance: ['What is my profit this month so far?', 'Where did my money go this month?', 'How do sales compare with last month?'],
  staff: ['Who clocked in today?', 'How was attendance this month?', 'Which shifts are planned this week?'],
  manager: ['How is my restaurant doing right now?', 'What needs my attention?', 'What are our best-selling items this week?'],
  admin: ['Give me my owner scorecard', 'What changed in the restaurant recently?', 'How are my branches doing?'],
};

export function AiChat({ slug, module = 'global', compact = false }: { slug: string; module?: AiModuleKey; compact?: boolean }) {
  const supabase = usePortalSupabase();
  // The branch being viewed (multi-branch) — the API narrows reports and answers to it.
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // What the assistant is doing right now ("Checking today summary…").
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drilldownCard, setDrilldownCard] = useState<ProfitCard | null>(null);
  const [orderDrilldown, setOrderDrilldown] = useState<OrderProfitRow | null>(null);
  const [dealDrilldown, setDealDrilldown] = useState<{ period: string; deals: DealProfitRow[] } | null>(null);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Saved chats (tenant-migrations/0081): the one open now, and this person's list.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<SavedChat[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const getToken = async () => (await supabase.auth.getSession()).data.session?.access_token ?? null;
  const voice = useAiVoice({ slug, module, getToken });
  const mic = useSpeechInput({
    language: voice.micLanguage,
    server: voice.server,
    preferServer: voice.prefs.serverSpeech,
    // Spoken words land in the box to check and edit; nothing is sent until Ask.
    onText: (text) => {
      setInput((cur) => (cur.trim() ? `${cur.trim()} ${text}` : text));
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  });
  useEffect(() => () => stopSpeech(), []);

  async function loadHistory() {
    const { data } = await supabase
      .from('ai_conversations')
      .select('id, title, updated_at, message_count')
      .eq('kind', 'staff')
      .order('updated_at', { ascending: false })
      .limit(100);
    setHistory((data as SavedChat[] | null) ?? []);
  }
  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  function newChat() {
    if (busy) return;
    setMsgs([]);
    setConversationId(null);
    setError(null);
    setHistoryOpen(false);
  }

  async function openChat(id: string) {
    if (busy) return;
    setLoadingChat(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('ai_messages')
      .select('role, content, attachment, extras')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });
    setLoadingChat(false);
    if (err) {
      setError(err.message);
      return;
    }
    type Row = { role: 'user' | 'assistant'; content: string; attachment: FileRef | null; extras: Record<string, unknown> | null };
    setMsgs(
      ((data as Row[] | null) ?? []).map((r) => {
        const x = r.extras ?? {};
        return {
          role: r.role,
          content: r.content,
          attachment: r.attachment ?? undefined,
          tools: (x.tools as string[] | undefined) ?? undefined,
          pendingAction: (x.pendingAction as PendingAction | undefined) ?? undefined,
          profitCard: (x.profitCard as ProfitCard | undefined) ?? undefined,
          orderCard: (x.orderCard as OrderProfitRow | undefined) ?? undefined,
          dealCard: (x.dealCard as { period: string; deals: DealProfitRow[] } | undefined) ?? undefined,
          document: (x.document as { title: string; content: string } | undefined) ?? undefined,
          fromHistory: true,
          // Saved answers don't store their language; the text itself says (direction, read-aloud voice).
          language: r.role === 'assistant' ? detectLanguage(r.content)?.code : undefined,
        };
      }),
    );
    setConversationId(id);
    setHistoryOpen(false);
    scrollDown();
  }

  async function deleteChat(id: string) {
    if (!window.confirm('Delete this chat? It cannot be recovered.')) return;
    const { error: err } = await supabase.from('ai_conversations').delete().eq('id', id);
    if (err) {
      setError(err.message);
      return;
    }
    if (id === conversationId) newChat();
    loadHistory();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError('That file is too large — attachments are limited to 10 MB.');
      return;
    }
    const lower = file.name.toLowerCase();
    const mimeType = file.type || (lower.endsWith('.csv') ? 'text/csv' : lower.endsWith('.txt') ? 'text/plain' : '');
    if (!ACCEPTED_ATTACHMENT_TYPES.has(mimeType)) {
      setError('Unsupported file — attach a PDF, an image (JPEG/PNG/GIF/WEBP), a CSV, or a plain text file.');
      return;
    }
    setPendingFile({ file, name: file.name, mimeType });
  }

  /** Uploads a file to the viewer's own folder in the private 'ai-chat' bucket. */
  async function uploadAttachment(p: PendingFile): Promise<FileRef> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Your session expired — sign in again.');
    const safe = p.name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-80);
    const storagePath = `${user.id}/${Date.now()}-${safe}`;
    const { error: upErr } = await supabase.storage.from('ai-chat').upload(storagePath, p.file, { contentType: p.mimeType });
    if (upErr) throw new Error(upErr.message);
    return { name: p.name, mimeType: p.mimeType, storagePath };
  }

  function scrollDown() {
    requestAnimationFrame(() => boxRef.current?.scrollTo(0, boxRef.current.scrollHeight));
  }

  async function authHeader() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` };
  }

  async function send(text: string) {
    const pending = pendingFile;
    const q = text.trim() || (pending ? `Please read "${pending.name}" and tell me what it contains.` : '');
    if (!q || busy) return;
    setError(null);
    // The file is uploaded once; its message keeps the reference, so later
    // questions about it still reach the model (the server loads the few
    // most recent attachments each turn).
    let attachment: FileRef | undefined;
    if (pending) {
      setBusy(true);
      setStatus(`Uploading ${pending.name}…`);
      try {
        attachment = await uploadAttachment(pending);
      } catch (err) {
        setBusy(false);
        setStatus(null);
        setError(`Couldn't upload "${pending.name}": ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setInput('');
    setPendingFile(null);
    const next: Msg[] = [...msgs, { role: 'user', content: q, attachment }];
    // The reply streams into this placeholder as it's written.
    const replyIndex = next.length;
    setMsgs([...next, { role: 'assistant', content: '' }]);
    setBusy(true);
    setStatus(null);
    scrollDown();
    const patchReply = (patch: Partial<Msg> | ((m: Msg) => Partial<Msg>)) =>
      setMsgs((all) => all.map((m, i) => (i === replyIndex ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)));
    // A failed request leaves no empty bubble behind (a partly written
    // answer stays, with the error shown under it).
    const dropEmptyReply = () =>
      setMsgs((all) => (all[replyIndex] && !all[replyIndex]!.content.trim() ? all.filter((_, i) => i !== replyIndex) : all));
    // Right-to-left from the first word when the answer language is known up front.
    patchReply({ language: voice.answerChoice !== 'auto' ? voice.answerChoice : (detectLanguage(q)?.code ?? 'en') });
    const controller = new AbortController();
    abortRef.current = controller;
    let streamed = '';
    try {
      const result = await streamAiChat(
        `${API}/api/ai/chat`,
        await authHeader(),
        {
          slug,
          // The latest part of the conversation (a long saved chat can exceed what one request carries).
          messages: next
            .filter((m) => m.content.trim())
            .slice(-30)
            .map((m) => ({ role: m.role, content: m.content.slice(0, 30000), ...(m.attachment ? { attachment: m.attachment } : {}) })),
          ...(conversationId ? { conversationId } : {}),
          module,
          responseLanguage: voice.answerChoice,
        },
        {
          status: (label) => setStatus(label),
          delta: (text) => {
            setStatus(null);
            streamed += text;
            patchReply((m) => ({ content: m.content + text }));
            scrollDown();
          },
        },
        controller.signal,
      );
      if (!result.ok) {
        if (result.code === 'aborted') {
          patchReply((m) => ({ content: m.content.trim() ? `${m.content}\n\n_(stopped)_` : '' }));
          dropEmptyReply();
          return;
        }
        setError(result.error);
        dropEmptyReply();
        return;
      }
      const data = result.done;
      const finalText = streamed.trim() ? streamed : String(data.reply ?? '(no answer)');
      // With "Automatic", the answer is shown and read in the language it was actually written in.
      const answerLanguage =
        voice.answerChoice !== 'auto'
          ? voice.answerChoice
          : (detectLanguage(finalText)?.code ?? (typeof data.language === 'string' ? data.language : undefined));
      patchReply((m) => ({
        language: answerLanguage ?? m.language,
        content: m.content.trim() ? m.content : finalText,
        tools: ((data.tools as { name: string }[] | undefined) ?? []).map((x) => x.name),
        pendingAction: (data.pendingAction as PendingAction | null) ?? undefined,
        profitCard: (data.profitCard as ProfitCard | null) ?? undefined,
        orderCard: (data.orderCard as OrderProfitRow | null) ?? undefined,
        dealCard: (data.dealCard as { period: string; deals: DealProfitRow[] } | null) ?? undefined,
        document: (data.document as { title: string; content: string } | null) ?? undefined,
      }));
      if (typeof data.conversationId === 'string') {
        setConversationId(data.conversationId);
        loadHistory();
      }
      scrollDown();
      // Announce the finished answer to screen readers and, if chosen, read it aloud.
      setAnnounce(data.pendingAction ? `${finalText} A change is waiting for you to confirm or cancel.` : finalText);
      if (voice.speakEnabled && voice.prefs.autoSpeak) speak(`reply-${replyIndex}`, finalText, answerLanguage ?? 'en', { voiceName: voice.voiceName, rate: voice.rate });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStatus(null);
    }
  }

  async function confirmAction(index: number, action: PendingAction) {
    setConfirming(index);
    try {
      const res = await fetch(`${API}/api/ai/confirm`, {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ slug, name: action.name, args: action.args, pendingActionId: action.id || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      // generate_report is the one action that doesn't mutate anything —
      // its "result" is the report data itself, which this component turns
      // into a real PDF client-side (the same buildReportDoc() the
      // Dashboard's own "Generate Report" button calls), rather than the
      // server trying to produce/host a file. saveAndStoreReportPdf also
      // permanently stores it (spec's permanent-storage requirement),
      // patching the audit row /confirm already created using its
      // returned auditId — non-fatal if that fails, the download itself
      // already happened by then.
      if (res.ok && action.name === 'generate_report' && body.result) {
        try {
          const { saveAndStoreReportPdf, REPORT_DOMAIN_SECTIONS } = await import('@/lib/generateReport');
          const domain = (action.args.domain as string | undefined) ?? 'complete';
          const sections = domain !== 'complete' ? REPORT_DOMAIN_SECTIONS[domain] : undefined;
          await saveAndStoreReportPdf(body.result, { sections, domain }, { supabase, auditId: body.auditId ?? null, domain });
        } catch (err) {
          console.error('PDF generation failed:', err);
        }
      }
      // export_excel_report only validates the range (it can't build the
      // workbook itself without a circular import — see aiTools.ts) and
      // hands back exactly what GET /api/ai/export/excel needs; the actual
      // .xlsx is fetched and downloaded here, same trigger-from-chat
      // pattern as the PDF above.
      if (res.ok && action.name === 'export_excel_report' && body.result?.ready) {
        try {
          const r = body.result as { from: string; to: string; sheets?: string[] };
          // from/to are always both present and always take priority over
          // period in resolvePeriod() (aiTools.ts) — passing the exact
          // resolved range here, not the period name, is what keeps this
          // download identical to the range export_excel_report validated.
          const qs = new URLSearchParams({ slug, from: r.from, to: r.to, ...(r.sheets && r.sheets.length > 0 ? { sheets: r.sheets.join(',') } : {}) });
          const dl = await fetch(`${API}/api/ai/export/excel?${qs.toString()}`, { headers: await authHeader() });
          if (dl.ok) {
            const blob = await dl.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${slug}-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }
        } catch (err) {
          console.error('Excel export download failed:', err);
        }
      }
      setMsgs((m) =>
        m.map((msg, i) =>
          i === index
            ? {
                ...msg,
                resolution: res.ok ? 'confirmed' : 'failed',
                resolutionMessage: res.ok ? body.message : (body.message ?? 'Could not complete that.'),
              }
            : msg,
        ),
      );
      scrollDown();
    } catch {
      setMsgs((m) =>
        m.map((msg, i) => (i === index ? { ...msg, resolution: 'failed', resolutionMessage: 'Network error.' } : msg)),
      );
    } finally {
      setConfirming(null);
    }
  }

  function cancelAction(index: number, action: PendingAction) {
    setMsgs((m) =>
      m.map((msg, i) => (i === index ? { ...msg, resolution: 'cancelled', resolutionMessage: 'Cancelled.' } : msg)),
    );
    // Best-effort — the local UI has already moved on regardless of whether
    // this succeeds; it just keeps the persisted Approval Inbox row (spec
    // §29) from sitting there as "pending" forever after being cancelled
    // right here in chat.
    if (action.id) {
      authHeader().then((headers) =>
        fetch(`${API}/api/ai/pending/${action.id}/reject`, { method: 'POST', headers, body: JSON.stringify({ slug }) }).catch(() => {}),
      );
    }
  }

  const currentTitle = history.find((h) => h.id === conversationId)?.title;

  const suggestions = (module !== 'global' && MODULE_SUGGESTIONS[module]) || SUGGESTIONS;
  const answerName = voice.answerChoice === 'auto' ? 'Auto' : (aiLanguage(voice.answerChoice)?.native ?? voice.answerChoice);
  const lastLang = [...msgs].reverse().find((m) => m.role === 'assistant' && m.language)?.language;

  return (
    <div className={compact ? 'relative flex min-h-0 flex-1 flex-col bg-surface' : 'relative rounded-lg border border-border bg-surface flex flex-col h-[65vh]'}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          aria-expanded={historyOpen}
          className="shrink-0 text-xs font-semibold rounded border border-border px-2.5 py-1 hover:border-primary"
        >
          History{history.length ? ` (${history.length})` : ''} <span aria-hidden>▾</span>
        </button>
        <span className="min-w-[4rem] flex-1 text-xs text-muted truncate">{loadingChat ? 'Opening chat…' : currentTitle ?? (msgs.length ? 'New chat' : '')}</span>
        {/* Inside the AI Guide the panel header already has this control. */}
        {!compact && (
          <button
            type="button"
            onClick={() => setVoiceOpen((v) => !v)}
            aria-expanded={voiceOpen}
            aria-label={`Language and voice settings (answers: ${voice.answerChoice === 'auto' ? 'automatic' : (aiLanguage(voice.answerChoice)?.name ?? voice.answerChoice)})`}
            className="shrink-0 text-xs font-semibold rounded border border-border px-2.5 py-1 hover:border-primary"
          >
            <span aria-hidden>文A {answerName}</span>
          </button>
        )}
        <button
          type="button"
          onClick={newChat}
          disabled={busy}
          className="shrink-0 text-xs font-semibold rounded bg-primary text-primary-fg px-2.5 py-1 disabled:opacity-50"
        >
          + New chat
        </button>
      </div>
      {voiceOpen && (
        <div className="border-b border-border bg-main p-3 max-h-[55%] overflow-y-auto">
          <AiVoiceSettings voice={voice} answerLanguage={lastLang ?? (voice.answerChoice !== 'auto' ? voice.answerChoice : voice.micLanguage)} onClose={() => setVoiceOpen(false)} />
        </div>
      )}
      {historyOpen && (
        <div className="absolute left-2 right-2 top-11 z-20 max-h-[50vh] overflow-y-auto rounded-lg border border-border bg-surface shadow-xl">
          {history.length === 0 ? (
            <p className="p-3 text-xs text-muted">No saved chats yet — every chat you start is saved here automatically.</p>
          ) : (
            history.map((h) => (
              <div
                key={h.id}
                className={`flex items-center gap-2 px-3 py-2 border-b border-border/60 last:border-0 ${h.id === conversationId ? 'bg-primary/10' : 'hover:bg-main'}`}
              >
                <button type="button" onClick={() => openChat(h.id)} className="flex-1 min-w-0 text-left">
                  <div className="text-xs font-semibold truncate">{h.title}</div>
                  <div className="text-[0.625rem] text-muted">
                    {new Date(h.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ·{' '}
                    {h.message_count} messages
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => deleteChat(h.id)}
                  className="text-muted hover:text-danger text-sm px-1"
                  aria-label={`Delete chat "${h.title}"`}
                  title="Delete chat"
                >
                  🗑
                </button>
              </div>
            ))
          )}
        </div>
      )}
      <div ref={boxRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {msgs.length === 0 ? (
          <div className="space-y-2">
            <p className="text-muted text-xs">Try asking (in any language — type or tap the microphone):</p>
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="block text-left text-xs rounded border border-border px-3 py-2 hover:border-primary"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-end' : ''}>
              {m.role === 'user' ? (
                <div
                  lang={detectLanguage(m.content)?.code}
                  dir="auto"
                  className="inline-block rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[85%] bg-primary text-primary-fg text-start"
                >
                  <span className="sr-only">You asked: </span>
                  {m.content}
                </div>
              ) : m.content ? (
                <div
                  lang={m.language}
                  dir={isRtlLanguage(m.language) ? 'rtl' : 'ltr'}
                  className={`inline-block rounded-lg px-3 py-2 text-sm max-w-[85%] bg-main border border-border text-start ${isRtlLanguage(m.language) ? 'leading-loose' : ''}`}
                >
                  <span className="sr-only">Assistant: </span>
                  <Markdown text={m.content} />
                  {busy && i === msgs.length - 1 && <span className="inline-block w-1.5 h-3.5 align-middle bg-current opacity-60 motion-safe:animate-pulse ms-0.5" aria-hidden />}
                </div>
              ) : null}
              {m.attachment && (
                <div className="text-[0.625rem] text-muted mt-1">📎 {m.attachment.name}</div>
              )}
              {m.document && (
                <div className="mt-2 max-w-[85%] rounded-lg border border-primary/40 bg-primary/5 p-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[0.625rem] text-muted font-semibold uppercase tracking-wide">PDF document</div>
                    <div className="text-sm font-semibold truncate">{m.document.title}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadTextPdf(m.document!.title, m.document!.content)}
                    className="shrink-0 rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs"
                  >
                    Download PDF
                  </button>
                </div>
              )}
              {m.role === 'assistant' && m.content && !(busy && i === msgs.length - 1) && (
                <div className="text-[0.625rem] text-muted mt-1 flex flex-wrap items-center gap-2">
                  {voice.speakEnabled && <SpeakControls id={`reply-${i}`} text={m.content} language={m.language ?? 'en'} voice={voice} />}
                  {m.tools && m.tools.length > 0 && <span>· {m.tools.join(' · ')}</span>}
                  <button
                    type="button"
                    onClick={() => downloadTextPdf(pdfTitleFor(msgs, i), m.content)}
                    className="font-semibold text-primary hover:underline"
                  >
                    Save as PDF
                  </button>
                </div>
              )}
              {m.profitCard && (
                <button
                  onClick={() => setDrilldownCard(m.profitCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">{m.profitCard.period}</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <div className="text-[0.625rem] text-muted">Net sales</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.profitCard.net_sales_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[0.625rem] text-muted">Gross profit</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.profitCard.gross_profit_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[0.625rem] text-muted">Net profit</div>
                      <div className={`font-mono font-bold text-sm ${m.profitCard.net_profit_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {formatCents(m.profitCard.net_profit_cents)}
                      </div>
                    </div>
                  </div>
                </button>
              )}
              {m.orderCard && (
                <button
                  onClick={() => setOrderDrilldown(m.orderCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">Order #{m.orderCard.order_number}</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <div>
                      <div className="text-[0.625rem] text-muted">Net sales</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.orderCard.net_sales_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[0.625rem] text-muted">COGS</div>
                      <div className="font-mono font-bold text-sm">{formatCents(m.orderCard.cogs_cents)}</div>
                    </div>
                    <div>
                      <div className="text-[0.625rem] text-muted">Contribution</div>
                      <div className={`font-mono font-bold text-sm ${m.orderCard.contribution_cents >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {formatCents(m.orderCard.contribution_cents)}
                      </div>
                    </div>
                  </div>
                </button>
              )}
              {m.dealCard && (
                <button
                  onClick={() => setDealDrilldown(m.dealCard!)}
                  className="mt-2 max-w-[85%] w-full block rounded-lg border border-primary/40 bg-primary/5 hover:border-primary p-3 text-left"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted font-semibold">{m.dealCard.period} · {m.dealCard.deals.length} deal(s)</span>
                    <span className="text-primary font-semibold">View breakdown →</span>
                  </div>
                  <div className="text-[0.6875rem] text-muted mt-1">
                    Top: {m.dealCard.deals.slice().sort((a, b) => b.contribution_cents - a.contribution_cents)[0]?.name}
                  </div>
                </button>
              )}
              {m.pendingAction && (
                <div className="mt-2 max-w-[85%] rounded-lg border border-primary/40 bg-primary/5 p-3 text-left">
                  <p className="text-xs font-semibold mb-2">{m.pendingAction.summary}</p>
                  {m.pendingAction.name === 'add_inventory_items' && Array.isArray((m.pendingAction.args as { items?: unknown[] })?.items) && (
                    <div className="mb-3 max-h-48 overflow-auto rounded border border-border/80 bg-surface/80 p-2 text-[0.6875rem]" tabIndex={0} role="group" aria-label="Table — scroll to see more">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-muted border-b border-border/60">
                            <th className="pb-1 font-semibold">Item</th>
                            <th className="pb-1 font-semibold">Unit</th>
                            <th className="pb-1 font-semibold text-right">Stock</th>
                            <th className="pb-1 font-semibold text-right">Cost</th>
                            <th className="pb-1 font-semibold text-right">Min</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((m.pendingAction.args as { items: Array<{ name: string; unit?: string; stock_qty?: number; cost_cents_per_unit?: number; min_threshold?: number }> }).items).map((it, idx) => (
                            <tr key={idx} className="border-b border-border/30 last:border-0">
                              <td className="py-1 font-medium">{it.name}</td>
                              <td className="py-1 text-muted">{it.unit ?? 'unit'}</td>
                              <td className="py-1 text-right">{it.stock_qty ?? 0}</td>
                              <td className="py-1 text-right font-mono">{it.cost_cents_per_unit != null ? formatCents(it.cost_cents_per_unit) : '—'}</td>
                              <td className="py-1 text-right text-muted">{it.min_threshold ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {m.pendingAction.name === 'add_menu_items' && Array.isArray((m.pendingAction.args as { items?: unknown[] })?.items) && (
                    <div className="mb-3 max-h-48 overflow-auto rounded border border-border/80 bg-surface/80 p-2 text-[0.6875rem]" tabIndex={0} role="group" aria-label="Table — scroll to see more">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-muted border-b border-border/60">
                            <th className="pb-1 font-semibold">Dish</th>
                            <th className="pb-1 font-semibold">Category</th>
                            <th className="pb-1 font-semibold text-right">Price</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((m.pendingAction.args as { items: Array<{ name: string; category_name?: string; price_cents: number }> }).items).map((it, idx) => (
                            <tr key={idx} className="border-b border-border/30 last:border-0">
                              <td className="py-1 font-medium">{it.name}</td>
                              <td className="py-1 text-muted">{it.category_name ?? 'Mains'}</td>
                              <td className="py-1 text-right font-mono font-bold">{formatCents(it.price_cents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {m.pendingAction.name === 'record_expenses' && Array.isArray((m.pendingAction.args as { expenses?: unknown[] })?.expenses) && (
                    <div className="mb-3 max-h-48 overflow-auto rounded border border-border/80 bg-surface/80 p-2 text-[0.6875rem]" tabIndex={0} role="group" aria-label="Table — scroll to see more">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-muted border-b border-border/60">
                            <th className="pb-1 font-semibold">Category</th>
                            <th className="pb-1 font-semibold">Description</th>
                            <th className="pb-1 font-semibold text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((m.pendingAction.args as { expenses: Array<{ category: string; description?: string; amount_cents: number }> }).expenses).map((ex, idx) => (
                            <tr key={idx} className="border-b border-border/30 last:border-0">
                              <td className="py-1 font-semibold">{ex.category}</td>
                              <td className="py-1 text-muted">{ex.description || '—'}</td>
                              <td className="py-1 text-right font-mono font-bold text-danger">{formatCents(ex.amount_cents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {m.pendingAction.name === 'add_staff_members' && Array.isArray((m.pendingAction.args as { staff?: unknown[] })?.staff) && (
                    <div className="mb-3 max-h-48 overflow-auto rounded border border-border/80 bg-surface/80 p-2 text-[0.6875rem]" tabIndex={0} role="group" aria-label="Table — scroll to see more">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-muted border-b border-border/60">
                            <th className="pb-1 font-semibold">Name</th>
                            <th className="pb-1 font-semibold">Role / Title</th>
                            <th className="pb-1 font-semibold text-right">Contact</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((m.pendingAction.args as { staff: Array<{ full_name: string; job_title: string; phone?: string; email?: string }> }).staff).map((st, idx) => (
                            <tr key={idx} className="border-b border-border/30 last:border-0">
                              <td className="py-1 font-medium">{st.full_name}</td>
                              <td className="py-1 font-semibold text-primary">{st.job_title}</td>
                              <td className="py-1 text-right text-muted">{st.phone || st.email || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {m.fromHistory && !m.resolution ? (
                    <p className="text-[0.6875rem] text-muted">From an earlier chat — ask again to redo it, or approve it in Approvals.</p>
                  ) : !m.resolution ? (
                    <div className="flex gap-2">
                      <button
                        onClick={() => confirmAction(i, m.pendingAction!)}
                        disabled={confirming === i}
                        className="rounded bg-primary text-primary-fg font-bold px-3 py-1.5 text-xs disabled:opacity-50"
                      >
                        {confirming === i ? 'Working…' : 'Confirm'}
                      </button>
                      <button
                        onClick={() => cancelAction(i, m.pendingAction!)}
                        disabled={confirming === i}
                        className="rounded border border-border px-3 py-1.5 text-xs font-semibold"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <p
                      className={`text-xs font-semibold ${
                        m.resolution === 'confirmed'
                          ? 'text-ok'
                          : m.resolution === 'failed'
                            ? 'text-danger'
                            : 'text-muted'
                      }`}
                    >
                      {m.resolution === 'confirmed' ? '✓ ' : m.resolution === 'failed' ? '✗ Not done: ' : ''}
                      {m.resolutionMessage}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {busy && (status || !msgs[msgs.length - 1]?.content) && (
          <p className="text-muted text-xs flex items-center gap-1.5" role="status">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />
            {status ?? 'Thinking…'}
          </p>
        )}
        {error && (
          <p className="text-danger text-xs" role="alert">
            <strong>Not answered: </strong>
            {error}
          </p>
        )}
      </div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announce ? `Assistant answered: ${announce}` : ''}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border p-3 space-y-2"
      >
        {pendingFile && (
          <div className="flex items-center gap-2 text-xs bg-main border border-border rounded px-2.5 py-1.5 w-fit">
            <span>📎 {pendingFile.name}</span>
            <button
              type="button"
              onClick={() => setPendingFile(null)}
              className="text-muted hover:text-danger font-bold"
              aria-label="Remove attachment"
            >
              ×
            </button>
          </div>
        )}
        {voice.micEnabled && <VoiceStatus mic={mic} language={voice.micLanguage} />}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.csv,.txt,text/csv,text/plain"
            onChange={handleFileSelect}
            className="hidden"
            tabIndex={-1}
            aria-hidden
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title="Attach a PDF, image, CSV or text file (up to 10 MB)"
            aria-label="Attach a PDF, image, CSV or text file (up to 10 MB)"
            className="shrink-0 rounded border border-border px-3 py-2 text-sm hover:border-primary disabled:opacity-50"
          >
            <span aria-hidden>📎</span>
          </button>
          <input
            ref={inputRef}
            value={input}
            dir="auto"
            aria-label="Ask the assistant"
            onChange={(e) => setInput(e.target.value)}
            placeholder={pendingFile ? `Ask about ${pendingFile.name}… (or just press Ask)` : compact ? 'Ask about your restaurant…' : 'Ask anything — or attach a PDF to read, summarise or extract…'}
            className="flex-1 min-w-0 rounded border border-border bg-main px-3 py-2 text-sm outline-none focus:border-primary"
          />
          {voice.micEnabled && !busy && <MicButton mic={mic} language={voice.micLanguage} />}
          {busy && !pendingFile ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="shrink-0 rounded border border-border font-semibold px-3 py-2 text-sm hover:bg-main"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={busy || (!input.trim() && !pendingFile)}
              className="shrink-0 rounded bg-primary text-primary-fg font-semibold px-4 py-2 text-sm disabled:opacity-50"
            >
              Ask
            </button>
          )}
        </div>
      </form>

      {drilldownCard && (
        <ProfitDrilldownModal
          profit={drilldownCard}
          from={new Date(drilldownCard.from_ts)}
          to={new Date(drilldownCard.to_ts)}
          periodLabel={drilldownCard.period}
          onClose={() => setDrilldownCard(null)}
        />
      )}
      {orderDrilldown && <OrderDrilldownModal order={orderDrilldown} onClose={() => setOrderDrilldown(null)} />}
      {dealDrilldown && (
        <DealDrilldownModal period={dealDrilldown.period} deals={dealDrilldown.deals} onClose={() => setDealDrilldown(null)} />
      )}
    </div>
  );
}
