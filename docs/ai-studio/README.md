# Try the AI Assistant in Google AI Studio

These files are the assistant's real instructions and tool list, exported from
the code (`cd apps/api && npx tsx scripts/export-ai-studio.ts` regenerates them).
They contain **no secrets and no restaurant data**.

| File | What it is |
| --- | --- |
| `system-instructions.txt` | The assistant's instructions (what it does, how it answers, its rules). |
| `functions.json` | 63 functions: 50 data lookups and 13 actions it can propose. |

## Steps

1. Open [aistudio.google.com](https://aistudio.google.com) → **Create prompt** (chat).
2. Model: **Gemini 3.1 Flash Lite** (the one the live assistant uses first).
3. **System instructions**: paste all of `system-instructions.txt`, and replace
   `<paste today’s date and time here>` with the current date and time.
4. Right panel → **Tools** → turn on **Function calling** → **Edit** → paste all of `functions.json` → **Save**.
5. Ask questions.
   - General questions ("ideas for a weekend deal", "write a WhatsApp message") are answered directly.
   - Restaurant questions ("how were sales today?") make it call a function. AI Studio **cannot
     reach your database**, so it shows the call and waits: type a made-up result (for example
     `{"net_sales_cents": 430000, "completed_orders": 2}`) to see how it answers.

## Bringing a change back

If you improve the instructions in AI Studio, copy the new text and ask for it to be put into
`SYSTEM_PROMPT` in `apps/api/src/lib/aiTools.ts` — that is what the live assistant uses.
