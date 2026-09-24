/**
 * apps/web/src/lib/guideAi.ts
 *
 * Client-side helpers for the Automation Restaurant AI Guide widget.
 *
 * Exports:
 *   sendPublicGuideMessage  — unauthenticated (public site visitors)
 *   sendAuthGuideMessage    — authenticated (portal users; requires session token)
 *   logGuideEvent           — fire-and-forget analytics event
 *   containsSecret          — regex scan so we can warn before sending
 *   makeSessionId           — stable opaque id for the current widget session
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GuideMsg = { role: 'user' | 'assistant'; content: string };

export type GuideContext = {
  mode: 'public' | 'portal';
  page?: string;       // current pathname for contextual prompts
  slug?: string;       // restaurant slug (portal mode only)
};

export type GuideAction = {
  label: string;
  type: 'link' | 'billing_portal' | 'support' | 'external';
  href?: string;       // internal Next.js route
  url?: string;        // external URL (billing portal, docs, etc.)
};

export type GuideResponse = {
  reply: string;
  actions?: GuideAction[];
  provider?: string;
};

// ─── Secret detection ─────────────────────────────────────────────────────────

/**
 * Patterns that look like credentials users should never paste into chat.
 * If any matches, show a warning BEFORE sending the message.
 */
const SECRET_PATTERNS: RegExp[] = [
  /eyJhbGciOiJ[A-Za-z0-9_-]{20,}/,   // JWT (service_role key, access_token, etc.)
  /sbp_[a-f0-9]{40}/,                  // Supabase personal access token
  /sk_live_[A-Za-z0-9]{24,}/,          // Stripe live secret key
  /sk_test_[A-Za-z0-9]{24,}/,          // Stripe test secret key
  /rk_live_[A-Za-z0-9]{24,}/,          // Stripe restricted key
  /whsec_[A-Za-z0-9+/]{32,}/,          // Stripe webhook secret
  /re_[A-Za-z0-9]{24,}/,               // Resend API key
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

// ─── Session ID ───────────────────────────────────────────────────────────────

/** Opaque ID stable for the lifetime of the browser session (not persistent). */
export function makeSessionId(): string {
  if (typeof sessionStorage !== 'undefined') {
    const key = 'guide_ai_session_id';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(key, id);
    }
    return id;
  }
  return crypto.randomUUID();
}

// ─── API calls ────────────────────────────────────────────────────────────────

/** Unauthenticated — for public marketing site visitors. */
export async function sendPublicGuideMessage(
  messages: GuideMsg[],
  context: GuideContext,
): Promise<GuideResponse> {
  const endpoint =
    typeof window !== 'undefined'
      ? '/api/guide-ai/chat'
      : `${API}/api/public/guide-ai/chat`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? 'The guide is not available right now.');
  }
  return body as GuideResponse;
}

/** Authenticated — for portal users with a valid session token. */
export async function sendAuthGuideMessage(
  messages: GuideMsg[],
  context: GuideContext,
  token: string,
): Promise<GuideResponse> {
  const endpoint =
    typeof window !== 'undefined'
      ? '/api/guide-ai/chat'
      : `${API}/api/guide-ai/chat`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, context }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? 'The guide is not available right now.');
  }
  return body as GuideResponse;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export type GuideEvent =
  | 'widget_opened'
  | 'widget_closed'
  | 'prompt_selected'
  | 'message_sent'
  | 'article_shown'
  | 'issue_diagnosed'
  | 'guide_completed'
  | 'feature_recommended'
  | 'billing_opened'
  | 'signup_started'
  | 'trial_started'
  | 'support_escalated'
  | 'resolution_marked'
  | 'secret_warning_shown';

/** Fire-and-forget — never awaited, never blocks the UI. */
export function logGuideEvent(
  event: GuideEvent,
  sessionId: string,
  metadata: Record<string, unknown> = {},
  slug?: string,
): void {
  const endpoint =
    typeof window !== 'undefined'
      ? '/api/guide-ai/event'
      : `${API}/api/public/guide-ai/event`;
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, session_id: sessionId, tenant_slug: slug ?? null, metadata }),
  }).catch(() => {
    /* analytics failure is non-fatal */
  });
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export type GuideStreamContext = GuideContext & {
  restaurantName?: string;
  planTier?: string;
  subscriptionStatus?: string;
};

const SUGGEST_MARK = '[[SUGGEST]]';

/** Split the model's trailing "[[SUGGEST]] a | b | c" line off the answer. */
export function splitSuggestions(text: string): { body: string; suggestions: string[] } {
  const i = text.lastIndexOf(SUGGEST_MARK);
  if (i < 0) {
    // Hide a partially-streamed marker ("[[SUG…") while it's still arriving.
    const partial = text.lastIndexOf('[[');
    return { body: partial >= 0 && text.length - partial < SUGGEST_MARK.length + 1 ? text.slice(0, partial) : text, suggestions: [] };
  }
  const suggestions = text
    .slice(i + SUGGEST_MARK.length)
    .split('|')
    .map((s) => s.replace(/[\s*_`]+$/g, '').replace(/^[\s*_`-]+/, '').trim())
    .filter((s) => s.length > 1 && s.length < 90)
    .slice(0, 3);
  return { body: text.slice(0, i).trimEnd(), suggestions };
}

/**
 * Ask the guide and receive the answer as it's generated. `onText` gets the
 * full text so far on every chunk. Resolves with the quick-link actions the
 * server picked for this question.
 */
export async function streamGuideMessage(
  messages: GuideMsg[],
  context: GuideStreamContext,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal,
): Promise<{ actions: GuideAction[]; text: string }> {
  const res = await fetch('/api/guide-ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? 'The guide is not available right now.');
  }
  let actions: GuideAction[] = [];
  try {
    actions = JSON.parse(decodeURIComponent(res.headers.get('X-Guide-Actions') ?? '%5B%5D')) as GuideAction[];
  } catch {
    actions = [];
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    onText(text);
  }
  text += decoder.decode();
  onText(text);
  return { actions, text };
}
