import { NextResponse } from 'next/server';
import { z } from 'zod';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

const SYSTEM_PROMPT = `You are the Automation Restaurant Operations AI Assistant. You help restaurant owners, managers, and staff with operational management:
- Menu items, categories, pricing, and availability
- Kitchen display (KDS), orders, and ticket flow
- Recipe management and ingredient inventory deduction
- Staff shifts, roles, and attendance
- Daily close, payments, and checkout

Give clear, concise, actionable advice. If the user asks about specific numbers without live data available, explain how they can view or update that metric directly in the relevant portal section.`;

export async function POST(req: Request) {
  try {
    const json = await req.json();
    const messages: Array<{ role: string; content: string }> = json.messages || [];

    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (!contents.length) {
      return NextResponse.json({ reply: 'How can I assist your restaurant today?' });
    }

    if (!GEMINI_API_KEY) {
      return NextResponse.json({
        reply: 'Operational assistant is standing by. Review your active orders, kitchen tickets, or menu in the sidebar.',
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
        'I am ready to help manage operations. What area would you like to review?';
      return NextResponse.json({ reply, provider: 'gemini' });
    }

    return NextResponse.json({
      reply: 'Operational assistant is standing by. Review your active orders, kitchen tickets, or menu in the sidebar.',
      provider: 'fallback',
    });
  } catch {
    return NextResponse.json({
      reply: 'Ready to help with orders, inventory, staff, or kitchen setup.',
      provider: 'fallback',
    });
  }
}
