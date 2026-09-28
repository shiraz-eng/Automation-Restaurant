// Exports the AI Assistant's instructions and tool list for Google AI Studio
// (aistudio.google.com), so the assistant can be tried and tuned there.
// Contains no secrets and no restaurant data — only the prompt text and the
// function declarations the API sends to Gemini.
//
// Usage (from apps/api):  npx tsx scripts/export-ai-studio.ts [restaurant_slug]
// Writes:                 ../../docs/ai-studio/system-instructions.txt
//                         ../../docs/ai-studio/functions.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_TOOLS, AI_ACTIONS, SYSTEM_PROMPT } from '../src/lib/aiTools';

const slug = process.argv[2] ?? 'bbq-tonight';
const outDir = resolve(__dirname, '../../../docs/ai-studio');
mkdirSync(outDir, { recursive: true });

const nowLine =
  'Current date/time at this restaurant: <paste today’s date and time here> (Asia/Karachi). Resolve "tonight" / "tomorrow" / "this Friday" etc. against this, never against your own training cutoff.';
writeFileSync(resolve(outDir, 'system-instructions.txt'), SYSTEM_PROMPT(slug, nowLine) + '\n');

// Same shape routes/ai.ts sends to Gemini: a tool with no inputs has no
// `parameters` at all (Gemini rejects an empty object schema).
const functions = [...AI_TOOLS, ...AI_ACTIONS].map((t) => ({
  name: t.name,
  description: t.description,
  ...(Object.keys(t.input_schema.properties).length ? { parameters: t.input_schema } : {}),
}));
writeFileSync(resolve(outDir, 'functions.json'), JSON.stringify(functions, null, 2) + '\n');

console.log(`Wrote ${functions.length} functions (${AI_TOOLS.length} lookups, ${AI_ACTIONS.length} actions) to ${outDir}`);
