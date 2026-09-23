import { NextResponse } from 'next/server';
import { z } from 'zod';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(4000),
    }),
  ),
  context: z
    .object({
      mode: z.enum(['public', 'portal']).optional(),
      page: z.string().optional(),
      slug: z.string().optional(),
    })
    .optional(),
});

const SYSTEM_PROMPT = `You are the Automation Restaurant AI Guide — an intelligent, friendly product specialist and onboarding assistant for the Automation Restaurant SaaS platform.

Your primary mission is:
GUIDE → EXPLAIN → DIAGNOSE → RESOLVE → ONBOARD → CONVERT

Core Platform Knowledge:
- Automation Restaurant is a connected restaurant operating system providing isolated databases for each restaurant, real-time sync, and role-specific portals (Kitchen Display System, Floor, Cashier, Deliveries, Finance, and Owner Admin).
- Pricing Tiers:
  1. Starter: $49/mo ($39/mo billed annually). 5 users, 20 tables, 1 branch, POS & orders, QR table ordering, table management, basic reports.
  2. Professional (Most Popular): $129/mo ($103/mo billed annually). 20 users, unlimited tables, 1 branch. Adds Real-time KDS, recipe-based inventory deduction, staff scheduling, customer management, reservations, and branded menu.
  3. Enterprise: Custom pricing. Unlimited users, tables, and branches. Adds KDS station routing, multi-branch management, accounting integration, and custom branding.
- Key Capabilities:
  - Real-time KDS: Instant order ticket updates without screen refreshes.
  - Recipe Deduction: Automatically decrements raw ingredient inventory as menu items are sold.
  - Smart Import: AI-driven import for menus, recipes, inventory, suppliers, and staff.
  - Table QR Ordering: Contactless guest ordering and tracking.
- Safety Rules:
  - NEVER ask for passwords, credit card numbers, or secret keys (service_role, Stripe keys, JWTs). If a user pastes a secret, warn them to rotate it.
  - Keep responses clear, concise, and helpful. Use friendly, plain language.`;

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const parsed = chatSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const { messages, context } = parsed.data;
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Convert to Gemini parts format
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    try {
      if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 800,
            },
          }),
          signal: AbortSignal.timeout(12000),
        },
      );

      if (res.ok) {
        const data = await res.json();
        const reply =
          data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
          'I am here to help you get the most out of Automation Restaurant. What would you like to know?';

        // Suggest contextual actions based on message content
        const actions: Array<{ label: string; type: string; href?: string; url?: string }> = [];
        const lower = lastUserMessage.toLowerCase();
        if (lower.includes('price') || lower.includes('cost') || lower.includes('plan')) {
          actions.push({ label: 'View Pricing', type: 'link', href: '/pricing' });
          actions.push({ label: 'Get Started', type: 'link', href: '/get-started' });
        } else if (lower.includes('menu')) {
          if (context?.slug) {
            actions.push({ label: 'Open Menu Portal', type: 'link', href: `/r/${context.slug}/menu` });
          }
        } else if (lower.includes('start') || lower.includes('sign up') || lower.includes('register')) {
          actions.push({ label: 'Create Account', type: 'link', href: '/get-started' });
        }

        return NextResponse.json({
          reply,
          actions: actions.length > 0 ? actions : undefined,
          provider: 'gemini',
        });
      }
    } catch {
      // Fall through to knowledge-based fallback
    }

    // Knowledge-grounded fallback response if external API is temporarily down
    let fallbackReply =
      'Automation Restaurant is a complete operating system for modern restaurants — unifying Point of Sale, Kitchen Display (KDS), Recipe-based Inventory, Staff Management, and Guest QR ordering into one platform.';

    const lower = lastUserMessage.toLowerCase();
    if (lower.includes('price') || lower.includes('plan') || lower.includes('cost')) {
      fallbackReply =
        'We offer three simple plans:\n\n• **Starter**: $49/mo ($39/mo annual) — POS, QR table ordering, 5 staff accounts, and 20 tables.\n• **Professional**: $129/mo ($103/mo annual) — Adds Real-time KDS, recipe ingredient inventory deduction, and reservations.\n• **Enterprise**: Custom pricing — Unlimited branches, KDS station routing, and dedicated support.';
    } else if (lower.includes('setup') || lower.includes('start') || lower.includes('how')) {
      fallbackReply =
        'Setting up is simple:\n\n1. Sign up and choose your plan.\n2. Your dedicated restaurant database provisions automatically.\n3. Add your menu items or use our AI Menu Import.\n4. Invite your kitchen, cashier, and floor staff with custom portal logins.';
    }

    return NextResponse.json({
      reply: fallbackReply,
      provider: 'fallback',
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', message: 'Unable to process guide request.' },
      { status: 500 },
    );
  }
}
