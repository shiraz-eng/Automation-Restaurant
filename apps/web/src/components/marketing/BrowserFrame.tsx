/** Wraps a real product screenshot in a lightweight browser-window chrome so
 *  it reads as "the actual app" rather than a floating image. Deliberately
 *  plain (three dots + a URL pill) — the screenshot inside is the content. */
export function BrowserFrame({
  url,
  children,
  className = '',
}: {
  url: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl shadow-black/10 ${className}`}>
      <div className="flex items-center gap-2 border-b border-border bg-main/60 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-danger/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-warn/50" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok/50" />
        <span className="ml-2 truncate rounded-md bg-border/40 px-2.5 py-0.5 text-[11px] text-muted font-mono">
          {url}
        </span>
      </div>
      <div className="bg-main">{children}</div>
    </div>
  );
}
