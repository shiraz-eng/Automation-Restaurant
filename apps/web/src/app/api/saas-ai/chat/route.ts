import { NextResponse } from 'next/server';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const SYSTEM_PROMPT = `You are the Billing & Subscription AI assistant for Automation Restaurant.
You help restaurant owners understand their subscription, compare plans, understand billing intervals, and navigate to the billing portal.
Plans:
- Starter ($49/mo, $39/mo annual)
- Professional ($129/mo, $103/mo annual)
- Enterprise (Custom)
Never ask for credit card numbers or secret keys. Direct users to the payment settings or billing portal to update payment methods.`;

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const messages: Array<{ role: string; content: string }> = json.messages || [];

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (!contents.length) {
      return NextResponse.json({ reply: 'How can I help with your plan or billing?' });
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json({
        reply: 'Your subscription can be managed from the Billing tab. Upgrading unlocks Real-time KDS, recipe inventory deduction, and multi-terminal POS.',
        provider: 'fallback',
      });
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 600 },
        }),
        signal: AbortSignal.timeout(12000),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const reply =
        data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
        'You can manage your subscription, download invoices, and change payment methods directly from the Billing page.';
      return NextResponse.json({ reply, provider: 'gemini' });
    }

    return NextResponse.json({
      reply: 'Your subscription can be managed from the Billing tab. Upgrading unlocks Real-time KDS, recipe inventory deduction, and multi-terminal POS.',
      provider: 'fallback',
    });
  } catch {
    return NextResponse.json({
      reply: 'Subscription details and invoices can be reviewed in the Billing overview.',
      provider: 'fallback',
    });
  }
}
