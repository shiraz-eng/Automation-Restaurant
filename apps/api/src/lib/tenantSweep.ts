import { supabaseAdmin } from '../supabase';

/**
 * Runs a background job for every active restaurant, a few at a time, each
 * with its own time limit. The sweeps used to go one restaurant after another;
 * on Vercel (60 s per call, slow cold connections, ten restaurants whose
 * databases no longer answer) the call ran out of time before the restaurants
 * at the end of the list were reached — their low-stock emails never went out.
 * One restaurant failing or hanging never stops the others.
 */
export async function forEachActiveTenant(
  job: string,
  fn: (tenantId: string, slug: string) => Promise<void>,
  { concurrency = 6, timeoutMs = 25_000 }: { concurrency?: number; timeoutMs?: number } = {},
): Promise<void> {
  const { data: rows } = await supabaseAdmin.from('tenants').select('id, slug').eq('status', 'active');
  const queue = [...((rows ?? []) as { id: string; slug: string }[])];

  async function worker() {
    for (let t = queue.shift(); t; t = queue.shift()) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          fn(t.id, t.slug),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } catch (err) {
        console.error(`[${job}] ${t.slug}:`, err instanceof Error ? err.message : err);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}
